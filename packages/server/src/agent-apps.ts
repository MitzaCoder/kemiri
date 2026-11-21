import { request } from "node:http";
import { randomUUID } from "node:crypto";
import type { AppPublisher, AppSettings, DetectedAppPort, ProjectApp } from "@kemiri/protocol";
import { appAddress } from "./app-addresses.ts";
import type { AppActivity, AppRecord, AppRegistryDocument } from "./app-registry-document.ts";
import { ServerError } from "./errors.ts";
import { inAppWorkspace, isDetectableListener, linuxAppListenerSource, type AppListenerSource } from "./app-listeners.ts";
import type { Project, ProjectStore } from "./projects.ts";

export type PublishAppInput = { port: number; name: string; path?: string | undefined; taskId?: string | undefined };
export type AppAgent = { publisher: AppPublisher; taskId?: string | undefined };
type ActiveAppCheck = (app: Pick<ProjectApp, "taskId" | "publishedBy">) => boolean;

type AgentAppsOptions = {
	store: ProjectStore;
	settings: () => AppSettings;
	backendPort: () => number;
	backendOrigins: () => readonly string[];
	changed: (projectId: string) => void;
	now?: () => number;
	listenerSource?: AppListenerSource;
};

/** Probe only IPv4 loopback, including listeners bound to all interfaces. No redirects, body or caller-supplied path. */
function answersHttp(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const probe = request({ host: "127.0.0.1", port, method: "HEAD", agent: false, signal: AbortSignal.timeout(800) }, response => {
			resolve(true);
			response.destroy();
		});
		probe.once("error", () => resolve(false));
		probe.end();
	});
}

const denied = () => new ServerError("bad_request", "Agents may not publish apps on this backend.");
const NO_ADDRESS = "No app address is configured on this backend. Attach screenshots or an HTML artifact instead.";

export function appPublishReceipt(app: ProjectApp) {
	return { appId: app.appId, url: app.url, host: app.url ? new URL(app.url).hostname : null, state: app.state,
		warning: app.state === "pending" ? `The owner must allow this app in Running apps.${app.mode === "off" ? ` ${NO_ADDRESS}` : " No link is shown until approval."}` :
			app.state === "unpublished" ? "This app was unpublished." : app.state === "stopped" ? "Nothing listens on this app’s port." : !app.url ? NO_ADDRESS : null };
}

const LISTENER_INTERVAL = 30_000;
const RETENTION_MS = 86_400_000;

function publishedApp(record: AppRecord): ProjectApp {
	const { stoppedAt, unpublishedAt: _, ...app } = record;
	return stoppedAt ? { ...app, state: "stopped", url: null } : app;
}

type ListenerSnapshot = { ports: Set<number>; candidates: { port: number; cwd: string }[] };
type ProjectAppsList = { apps: ProjectApp[]; detected: DetectedAppPort[]; listenerChecksAvailable: boolean };

export class AgentApps {
	readonly #source: AppListenerSource;
	readonly #observed = new Map<string, string>();
	readonly #linkedWorkspaces = new Map<string, { expiresAt: number; paths: Promise<string[]> }>();
	#snapshot: { expiresAt: number; pending: Promise<ListenerSnapshot | null> } | undefined;
	#refreshing: Promise<void> | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor(readonly options: AgentAppsOptions) { this.#source = options.listenerSource ?? linuxAppListenerSource(); }

	start(onError: (error: unknown) => void): void {
		const tick = () => {
			if (this.#refreshing) return;
			this.#refreshing = this.refresh().catch(onError).finally(() => { this.#refreshing = undefined; });
		};
		this.#timer = setInterval(tick, LISTENER_INTERVAL);
		this.#timer.unref();
		tick();
	}

	async stop(): Promise<void> {
		clearInterval(this.#timer);
		await this.#refreshing;
	}

	async refresh(): Promise<void> {
		const projects = await this.options.store.list();
		for (const project of projects) {
			if (!project.apps?.records?.length && !project.apps?.activity?.length && !project.apps?.ignoredPorts?.length && !this.#observed.has(project.id)) continue;
			await this.#readProject(project, !project.archived && this.#observed.has(project.id));
		}
	}

	async list(projectId: string): Promise<ProjectApp[]> {
		const project = await this.options.store.require(projectId);
		if (!project.apps?.records?.length) return [];
		return (await this.#readProject(project, false)).apps;
	}

	async listForOwner(projectId: string): Promise<ProjectAppsList> {
		const project = await this.options.store.require(projectId);
		return this.#readProject(project, !project.archived);
	}

	#listeners(fresh = false): Promise<ListenerSnapshot | null> {
		if (!fresh && this.#snapshot && this.#snapshot.expiresAt > this.#now()) return this.#snapshot.pending;
		const pending = this.#source.listeners().then(async listeners => {
			if (listeners === null) return null;
			const cwdByPid = new Map<number, Promise<string | null>>();
			const candidates = (await Promise.all(listeners.filter(listener => isDetectableListener(listener, this.options.backendPort()))
				.flatMap(listener => listener.pids.map(async pid => {
					let pending = cwdByPid.get(pid);
					if (!pending) cwdByPid.set(pid, pending = this.#source.cwd(pid));
					const cwd = await pending;
					return cwd ? [{ port: listener.port, cwd }] : [];
				})))).flat();
			return { ports: new Set(listeners.map(listener => listener.port)), candidates };
		});
		this.#snapshot = { expiresAt: this.#now() + 1000, pending };
		return pending;
	}

	async #detect(project: Project, document: AppRegistryDocument, snapshot: ListenerSnapshot | null, fresh = false): Promise<DetectedAppPort[]> {
		if (!snapshot || project.archived) return [];
		const excluded = new Set([...(document.ignoredPorts ?? []), ...(document.records ?? []).filter(app => app.state !== "unpublished").map(app => app.port)]);
		const candidates = snapshot.candidates.filter(candidate => !excluded.has(candidate.port));
		if (!candidates.length) return [];
		const dataDir = this.options.store.projectDir(project.id);
		const direct = candidates.filter(({ cwd }) => inAppWorkspace(cwd, project.path, dataDir, []));
		const ports = new Set(direct.map(({ port }) => port));
		if (candidates.some(({ port }) => !ports.has(port))) {
			let linked = this.#linkedWorkspaces.get(project.id);
			if (fresh || !linked || linked.expiresAt <= this.#now()) {
				linked = { expiresAt: this.#now() + LISTENER_INTERVAL, paths: this.#source.workspaces(project.path) };
				this.#linkedWorkspaces.set(project.id, linked);
			}
			const paths = await linked.paths;
			for (const { port, cwd } of candidates) if (!ports.has(port) && inAppWorkspace(cwd, project.path, dataDir, paths)) ports.add(port);
		}
		return [...ports].sort((a, b) => a - b).map(port => ({ port }));
	}

	async #readProject(project: Project, detect: boolean): Promise<ProjectAppsList> {
		return this.#change(project.id, async document => {
			const snapshot = detect || document.records?.some(app => app.state === "live" || app.state === "pending") || document.ignoredPorts?.length
				? await this.#listeners() : null;
			const changed = this.#updateLifecycle(document, snapshot);
			const detected = detect ? await this.#detect(project, document, snapshot) : [];
			const listenerChecksAvailable = snapshot !== null;
			const signature = JSON.stringify([listenerChecksAvailable, detected]);
			const previous = this.#observed.get(project.id);
			if (detect) this.#observed.set(project.id, signature);
			return { result: { apps: (document.records ?? []).map(publishedApp), detected, listenerChecksAvailable }, changed,
				notify: detect && previous !== undefined && previous !== signature };
		});
	}

	#updateLifecycle(document: AppRegistryDocument, snapshot: ListenerSnapshot | null): boolean {
		const now = this.#timestamp();
		const cutoff = Date.parse(now) - RETENTION_MS;
		let changed = false;
		const records = document.records ?? [];
		const retained = records.filter(app => {
			const retiredAt = app.unpublishedAt ?? app.stoppedAt;
			return retiredAt === undefined || Date.parse(retiredAt) > cutoff;
		});
		if (retained.length !== records.length) { document.records = retained; changed = true; }
		const events = document.activity ?? [];
		const recent = events.filter(event => Date.parse(event.at) > cutoff);
		if (recent.length !== events.length) { document.activity = recent; changed = true; }
		if (!snapshot) return changed;
		const ignored = document.ignoredPorts ?? [];
		const stillListening = ignored.filter(port => snapshot.ports.has(port));
		if (stillListening.length !== ignored.length) { document.ignoredPorts = stillListening; changed = true; }
		for (const app of retained) {
			if (app.state !== "live") continue;
			if (!snapshot.ports.has(app.port) && !app.stoppedAt) { app.stoppedAt = now; changed = true; }
			else if (snapshot.ports.has(app.port) && app.stoppedAt) { delete app.stoppedAt; changed = true; }
		}
		return changed;
	}

	async publishDetected(projectId: string, port: number, publisher: AppPublisher): Promise<ProjectApp> {
		const project = await this.options.store.require(projectId);
		return this.#change(projectId, async document => {
			await this.#requireDetected(project, document, port);
			const app: ProjectApp = { projectId, appId: randomUUID(), port, name: `Port ${port}`, path: "/", url: null,
				state: "live", publishedBy: publisher, ownerPublished: true, mode: "off", createdAt: this.#timestamp() };
			this.#makeLive(app, this.options.settings());
			(document.records ??= []).unshift(app);
			this.#log(document, app, "published", "owner");
			return { result: app, changed: true };
		});
	}

	async ignoreDetected(projectId: string, port: number): Promise<void> {
		const project = await this.options.store.require(projectId);
		await this.#change(projectId, async document => {
			if (document.ignoredPorts?.includes(port)) return { result: undefined, changed: false };
			await this.#requireDetected(project, document, port);
			(document.ignoredPorts ??= []).push(port);
			return { result: undefined, changed: true };
		});
	}

	async #requireDetected(project: Project, document: AppRegistryDocument, port: number): Promise<void> {
		if (!(await this.#detect(project, document, await this.#listeners(true), true)).some(candidate => candidate.port === port)) {
			throw new ServerError("bad_request", "This port is no longer a detected app in this project.");
		}
	}

	async publish(projectId: string, input: PublishAppInput, agent: AppAgent, active: () => Promise<ActiveAppCheck>, appId = randomUUID() as string): Promise<ProjectApp> {
		if (this.options.settings().policy === "off") throw denied();
		const { port } = input;
		if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ServerError("bad_request", "Use an app port from 1024 to 65535.");
		if (port === this.options.backendPort()) throw new ServerError("bad_request", "Cannot publish Kemiri's own port.");
		const name = input.name.trim();
		if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new ServerError("bad_request", "Give the app a name of 1–120 characters on one line.");
		const path = input.path ?? "/";
		if (!path.startsWith("/") || path.startsWith("//") || path.length > 1024 || /[\s\\?#\u0000-\u001f\u007f]/u.test(path)) {
			throw new ServerError("bad_request", "Use an app path starting with one slash, without a query or fragment.");
		}
		const existing = (await this.options.store.require(projectId)).apps?.records?.find(app => app.appId === appId);
		if (existing) return publishedApp(existing);
		if (!await answersHttp(port)) throw new ServerError("bad_request", `Nothing answered HTTP on port ${port} on this backend.`);
		this.#snapshot = undefined;
		return this.#change(projectId, async document => {
			const existing = document.records?.find(app => app.appId === appId);
			if (existing) return { result: publishedApp(existing), changed: false };
			const taskId = input.taskId ?? agent.taskId;
			const app: ProjectApp = { appId, projectId, port, name, path, url: null, state: "pending", publishedBy: agent.publisher,
				...(taskId === undefined ? {} : { taskId }), mode: "off", createdAt: this.#timestamp() };
			if (!(await active())(app)) throw new ServerError("bad_request", "Publish from an active conversation and use an open task in this project, or no task.");
			const settings = this.options.settings();
			if (settings.policy === "off") throw denied();
			app.mode = settings.addresses.mode;
			if (settings.policy === "on" || document.approved) this.#makeLive(app, settings);
			(document.records ??= []).unshift(app);
			this.#log(document, app, "published", agent.publisher);
			return { result: app, changed: true };
		});
	}

	async allow(projectId: string, appId: string, active: () => Promise<ActiveAppCheck>): Promise<ProjectApp> {
		return this.#change(projectId, async document => {
			const app = this.#require(document, appId);
			if (app.state !== "pending") throw new ServerError("bad_request", "Only apps waiting for approval can be allowed.");
			if (!(await active())(app)) throw new ServerError("bad_request", "This app's task or conversation is no longer active.");
			const settings = this.options.settings();
			if (settings.policy === "off") throw denied();
			if (!await answersHttp(app.port)) throw new ServerError("bad_request", `Nothing answered HTTP on port ${app.port} on this backend.`);
			this.#snapshot = undefined;
			const latest = this.options.settings();
			if (latest.policy === "off") throw denied();
			if (!(await active())(app)) throw new ServerError("bad_request", "This app's task or conversation is no longer active.");
			this.#makeLive(app, latest);
			document.approved = true;
			this.#log(document, app, "allowed", "owner");
			return { result: app, changed: true };
		});
	}

	async unpublish(projectId: string, appId: string, actor: AppPublisher | "owner"): Promise<ProjectApp> {
		return this.#change(projectId, async document => {
			const app = this.#require(document, appId);
			const changed = this.#stop(document, app, actor);
			return { result: publishedApp(app), changed };
		});
	}

	/** Re-read lifecycle state inside the serialized write to avoid cleaning up a newer publication from a stale watch. */
	async reconcile(projectId: string, active: () => Promise<ActiveAppCheck>): Promise<void> {
		await this.#change(projectId, async document => {
			const apps = document.records?.filter(app => app.state !== "unpublished") ?? [];
			if (!apps.length) return { result: undefined, changed: false };
			const isActive = await active();
			let changed = false;
			for (const app of apps) if (!isActive(app)) changed = this.#stop(document, app, "cleanup") || changed;
			return { result: undefined, changed };
		});
	}

	#require(document: AppRegistryDocument, appId: string): AppRecord {
		const app = document.records?.find(record => record.appId === appId);
		if (!app) throw new ServerError("bad_request", "No app with that ID in this project.");
		return app;
	}

	#makeLive(app: ProjectApp, settings: AppSettings): void {
		let url: URL | null;
		try { url = appAddress(settings.addresses, app.port, app.path); }
		catch { throw new ServerError("bad_request", "The address template did not make a valid URL for this port."); }
		if (url && this.options.backendOrigins().some(origin => origin === url.origin)) {
			throw new ServerError("bad_request", "An app must have a different origin from Kemiri.");
		}
		app.mode = settings.addresses.mode;
		app.state = "live";
		app.url = url?.href ?? null;
	}

	#stop(document: AppRegistryDocument, app: AppRecord, actor: AppActivity["actor"]): boolean {
		if (app.state === "unpublished") return false;
		app.state = "unpublished";
		delete app.stoppedAt;
		app.unpublishedAt = this.#timestamp();
		app.url = null;
		this.#log(document, app, "unpublished", actor);
		return true;
	}

	#now(): number { return this.options.now?.() ?? Date.now(); }

	#timestamp(): string { return new Date(this.#now()).toISOString(); }

	#log(document: AppRegistryDocument, app: ProjectApp, kind: AppActivity["kind"], actor: AppActivity["actor"]): void {
		(document.activity ??= []).push({ kind, appId: app.appId, publishedBy: app.publishedBy, actor, at: this.#timestamp(),
			...(app.taskId === undefined ? {} : { taskId: app.taskId }) });
	}

	async #change<T>(projectId: string, update: (document: AppRegistryDocument) => Promise<{ result: T; changed: boolean; notify?: boolean }>): Promise<T> {
		const change = await this.options.store.updateAppRegistry(projectId, async document => {
			const change = await update(document);
			return { result: change, changed: change.changed };
		});
		if (change.changed || change.notify) this.options.changed(projectId);
		return change.result;
	}
}
