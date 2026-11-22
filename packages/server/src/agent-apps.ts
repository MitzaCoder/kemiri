import { request } from "node:http";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { APP_START_TIMEOUT_MS, ManagedAppProcesses, inManagedScope, processIdentity, validManagedAppId, type ManagedProcess } from "./managed-app-process.ts";
import { randomUUID } from "node:crypto";
import type { AppPublisher, AppSettings, DetectedAppPort, ProjectApp } from "@kemiri/protocol";
import { appAddress, appInstructions } from "./app-addresses.ts";
import { AppServeMappings } from "./app-serve-mappings.ts";
import { TailscaleServe } from "./tailscale.ts";
import type { AppActivity, AppRecord, AppRegistryDocument } from "./app-registry-document.ts";
import { ServerError } from "./errors.ts";
import { inAppWorkspace, isDetectableListener, linuxAppListenerSource, type AppListenerSource } from "./app-listeners.ts";
import type { Project, ProjectStore } from "./projects.ts";

export type PublishAppInput = { port: number; name: string; path?: string | undefined; taskId?: string | undefined };
export type StartAppInput = PublishAppInput & { command: string; cwd?: string | undefined };
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
	managedProcesses?: ManagedAppProcesses;
	startTimeoutMs?: number;
	tailscale?: TailscaleServe;
	log?: (message: string) => void;
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

function availableLoopbackPort(port: number): boolean {
	try {
		const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
		listener.stop(true);
		return true;
	} catch { return false; }
}

const denied = () => new ServerError("bad_request", "Agents may not publish apps on this backend.");
const NO_ADDRESS = "No app address is configured on this backend. Attach screenshots or an HTML artifact instead.";

export function appPublishReceipt(app: ProjectApp) {
	return { appId: app.appId, url: app.url, host: app.url ? new URL(app.url).hostname : null, state: app.state,
		warning: app.state === "pending" ? `The owner must allow this app in Running apps.${app.mode === "off" ? ` ${NO_ADDRESS}` : " No link is shown until approval."}` :
			app.state === "unpublished" ? "This app was unpublished." : app.state === "stopped" ? "Nothing listens on this app’s port." : !app.url ? app.addressMessage ?? NO_ADDRESS : null };
}

const LISTENER_INTERVAL = 30_000;
const RETENTION_MS = 86_400_000;

function publishedApp(record: AppRecord): ProjectApp {
	const { stoppedAt, unpublishedAt: _, serveMapping: __, managedProcess, ...app } = record;
	if (managedProcess) app.managed = { survivesRestart: managedProcess.process?.unit !== undefined };
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

	readonly tailscale: TailscaleServe;
	readonly #serveMappings: AppServeMappings;
	readonly #processes: ManagedAppProcesses;
	readonly #starts = new Map<string, Promise<ProjectApp>>();
	readonly #startingPorts = new Set<number>();
	#pending: Promise<unknown> = Promise.resolve();

	constructor(readonly options: AgentAppsOptions) {
		this.#source = options.listenerSource ?? linuxAppListenerSource();
		this.#processes = options.managedProcesses ?? new ManagedAppProcesses(options.store.dataDir);
		this.tailscale = options.tailscale ?? new TailscaleServe();
		this.#serveMappings = new AppServeMappings(options.store.dataDir, this.tailscale, options.backendPort, options.backendOrigins, options.log ?? console.warn);
	}

	async instructions(): Promise<string> {
		const settings = this.options.settings();
		const hostname = settings.addresses.mode === "tailscale-serve" && settings.policy !== "off" ? (await this.tailscale.status()).hostname : null;
		return appInstructions(settings, hostname ?? undefined);
	}

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
		await Promise.allSettled(this.#starts.values());
		await this.#pending;
	}

	async refresh(): Promise<void> {
		await this.#releaseOrphans();
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

	async #detectionInputs(project: Project, snapshot: ListenerSnapshot | null, fresh = false): Promise<readonly string[]> {
		const dataDir = this.options.store.projectDir(project.id);
		if (project.archived || !snapshot?.candidates.some(({ cwd }) => !inAppWorkspace(cwd, project.path, dataDir, []))) return [];
		let linked = this.#linkedWorkspaces.get(project.id);
		if (fresh || !linked || linked.expiresAt <= this.#now()) {
			linked = { expiresAt: this.#now() + LISTENER_INTERVAL, paths: this.#source.workspaces(project.path) };
			this.#linkedWorkspaces.set(project.id, linked);
		}
		return linked.paths;
	}

	#detect(project: Project, document: AppRegistryDocument, snapshot: ListenerSnapshot | null, linked: readonly string[]): DetectedAppPort[] {
		if (!snapshot || project.archived) return [];
		const excluded = new Set([...(document.ignoredPorts ?? []), ...(document.records ?? []).filter(app => app.state !== "unpublished").map(app => app.port)]);
		const dataDir = this.options.store.projectDir(project.id);
		const ports = new Set(snapshot.candidates.filter(({ port, cwd }) =>
			!excluded.has(port) && inAppWorkspace(cwd, project.path, dataDir, linked)).map(({ port }) => port));
		return [...ports].sort((a, b) => a - b).map(port => ({ port }));
	}

	async #readProject(project: Project, detect: boolean): Promise<ProjectAppsList> {
		// Process and workspace probes can take seconds; no registry queue is held while they run.
		const snapshot = detect || project.apps?.records?.some(app => app.state === "live" || app.state === "pending") || project.apps?.ignoredPorts?.length
			? await this.#listeners() : null;
		const linked = detect ? await this.#detectionInputs(project, snapshot) : [];
		return this.#change(project.id, async document => {
			let changed = await this.#updateLifecycle(document, snapshot, project.apps);
			const { addresses } = this.options.settings();
			for (const app of document.records ?? []) {
				if (app.state !== "live") continue;
				if (addresses.mode === "tailscale-serve" && (!app.stoppedAt || app.serveMapping)) {
					const before = JSON.stringify(app);
					await this.#serveMappings.resolve(app, addresses, () => this.#listeningPorts());
					changed ||= before !== JSON.stringify(app);
				} else if (addresses.mode !== "tailscale-serve" && app.mode === "tailscale-serve") {
					// Leaving Serve revokes its links. Other modes apply to future publications.
					app.mode = "off";
					app.url = null;
					delete app.serveMapping;
					delete app.addressMessage;
					changed = true;
				}
			}
			const detected = detect ? this.#detect(project, document, snapshot, linked) : [];
			const listenerChecksAvailable = snapshot !== null;
			const signature = JSON.stringify([listenerChecksAvailable, detected]);
			const previous = this.#observed.get(project.id);
			if (detect) this.#observed.set(project.id, signature);
			return { result: { apps: (document.records ?? []).filter(app => !app.managedProcess?.starting).map(publishedApp), detected, listenerChecksAvailable }, changed,
				notify: detect && previous !== undefined && previous !== signature };
		});
	}

	async #updateLifecycle(document: AppRegistryDocument, snapshot: ListenerSnapshot | null, observed: AppRegistryDocument | undefined): Promise<boolean> {
		const previouslyObserved = new Map(observed?.records?.map(app => [app.appId, app]));
		// Do not apply an older port observation to a row that appeared or changed while the scan was running.
		const observedRow = (app: AppRecord) => {
			const prior = previouslyObserved.get(app.appId);
			return prior?.createdAt === app.createdAt && prior.state === app.state && prior.stoppedAt === app.stoppedAt &&
				prior.managedProcess?.starting === app.managedProcess?.starting;
		};
		const now = this.#timestamp();
		const cutoff = Date.parse(now) - RETENTION_MS;
		let changed = false;
		const records = document.records ?? [];
		const retained: AppRecord[] = [];
		for (const app of records) {
			const managed = app.managedProcess;
			if (managed && !this.#starts.has(app.appId)) {
				const identity = await this.#identity(app);
				const alive = !!identity && await this.#processes.alive(app.appId, identity);
				if (app.state === "unpublished" && alive) await this.#processes.stop(app.appId, identity);
				if (managed.starting) {
					// The previous backend ended before publication was committed. Clean up its reserved start.
					if (alive) await this.#processes.stop(app.appId, identity);
					delete managed.starting;
					this.#stop(document, app, "cleanup");
					changed = true;
				} else if (app.state === "pending" && !alive) {
					changed = this.#stop(document, app, "cleanup") || changed;
				} else if (app.state === "live") {
					const observedPort = snapshot && observedRow(app) ? snapshot.ports.has(app.port) : undefined;
					const listening = alive && observedPort !== false;
					if (!listening && !app.stoppedAt) { app.stoppedAt = now; changed = true; }
					else if (listening && app.stoppedAt && observedPort === true) {
						delete app.stoppedAt;
						changed = true;
					}
				}
			}
			const retiredAt = app.unpublishedAt ?? app.stoppedAt;
			if (retiredAt !== undefined && Date.parse(retiredAt) <= cutoff && !this.#starts.has(app.appId)) {
				if (managed) {
					await this.#stopProcess(app);
					await this.#processes.remove(app.appId);
				}
				changed = true;
			} else retained.push(app);
		}
		if (retained.length !== records.length) document.records = retained;
		const events = document.activity ?? [];
		const recent = events.filter(event => Date.parse(event.at) > cutoff);
		if (recent.length !== events.length) { document.activity = recent; changed = true; }
		if (!snapshot) return changed;
		const ignored = document.ignoredPorts ?? [];
		const scannedIgnored = new Set(observed?.ignoredPorts);
		const stillListening = ignored.filter(port => !scannedIgnored.has(port) || snapshot.ports.has(port));
		if (stillListening.length !== ignored.length) { document.ignoredPorts = stillListening; changed = true; }
		for (const app of retained) {
			if (app.state !== "live" || app.managedProcess || !observedRow(app)) continue;
			if (!snapshot.ports.has(app.port) && !app.stoppedAt) { app.stoppedAt = now; changed = true; }
			else if (snapshot.ports.has(app.port) && app.stoppedAt) { delete app.stoppedAt; changed = true; }
		}
		return changed;
	}

	async publishDetected(projectId: string, port: number, publisher: AppPublisher): Promise<ProjectApp> {
		const project = await this.options.store.require(projectId);
		const snapshot = await this.#listeners(true);
		const linked = await this.#detectionInputs(project, snapshot, true);
		return this.#change(projectId, async document => {
			this.#requireDetected(project, document, port, snapshot, linked);
			const app: AppRecord = { projectId, appId: randomUUID(), port, name: `Port ${port}`, path: "/", url: null,
				state: "live", publishedBy: publisher, ownerPublished: true, mode: "off", createdAt: this.#timestamp() };
			await this.#makeLive(app, this.options.settings());
			(document.records ??= []).unshift(app);
			this.#log(document, app, "published", "owner");
			return { result: publishedApp(app), changed: true };
		});
	}

	async ignoreDetected(projectId: string, port: number): Promise<void> {
		const project = await this.options.store.require(projectId);
		if (project.apps?.ignoredPorts?.includes(port)) return;
		const snapshot = await this.#listeners(true);
		const linked = await this.#detectionInputs(project, snapshot, true);
		await this.#change(projectId, async document => {
			if (document.ignoredPorts?.includes(port)) return { result: undefined, changed: false };
			this.#requireDetected(project, document, port, snapshot, linked);
			(document.ignoredPorts ??= []).push(port);
			return { result: undefined, changed: true };
		});
	}

	#requireDetected(project: Project, document: AppRegistryDocument, port: number, snapshot: ListenerSnapshot | null, linked: readonly string[]): void {
		if (!this.#detect(project, document, snapshot, linked).some(candidate => candidate.port === port)) {
			throw new ServerError("bad_request", "This port is no longer a detected app in this project.");
		}
	}

	#draft(projectId: string, input: PublishAppInput, agent: AppAgent, appId: string): AppRecord {
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
		const taskId = input.taskId ?? agent.taskId;
		return { appId, projectId, port, name, path, url: null, state: "pending", publishedBy: agent.publisher,
			...(taskId === undefined ? {} : { taskId }), mode: "off", createdAt: this.#timestamp() };
	}

	async #checkPublication(app: AppRecord, active: () => Promise<ActiveAppCheck>): Promise<AppSettings> {
		if (!(await active())(app)) throw new ServerError("bad_request", "Publish from an active conversation and use an open task in this project, or no task.");
		const settings = this.options.settings();
		if (settings.policy === "off") throw denied();
		return settings;
	}

	async #finishPublication(document: AppRegistryDocument, app: AppRecord, active: () => Promise<ActiveAppCheck>) {
		const settings = await this.#checkPublication(app, active);
		app.mode = settings.addresses.mode;
		if (settings.policy === "on" || document.approved) await this.#makeLive(app, settings);
		this.#log(document, app, "published", app.publishedBy);
		return publishedApp(app);
	}

	async publish(projectId: string, input: PublishAppInput, agent: AppAgent, active: () => Promise<ActiveAppCheck>, appId = randomUUID() as string): Promise<ProjectApp> {
		const app = this.#draft(projectId, input, agent, appId);
		const existing = (await this.options.store.require(projectId)).apps?.records?.find(app => app.appId === appId);
		if (existing) return publishedApp(existing);
		if (!await answersHttp(app.port)) throw new ServerError("bad_request", `Nothing answered HTTP on port ${app.port} on this backend.`);
		this.#snapshot = undefined;
		return this.#change(projectId, async document => {
			const existing = document.records?.find(app => app.appId === appId);
			if (existing) return { result: publishedApp(existing), changed: false };
			const result = await this.#finishPublication(document, app, active);
			(document.records ??= []).unshift(app);
			return { result, changed: true };
		});
	}

	startManaged(projectId: string, input: StartAppInput, agent: AppAgent, active: () => Promise<ActiveAppCheck>, appId = randomUUID() as string): Promise<ProjectApp> {
		const pending = this.#starts.get(appId);
		if (pending) return pending;
		if (this.#startingPorts.has(input.port)) return Promise.reject(new ServerError("bad_request", `An app is already starting on port ${input.port}.`));
		this.#startingPorts.add(input.port);
		const start = this.#startManaged(projectId, input, agent, active, appId).finally(() => {
			this.#starts.delete(appId);
			this.#startingPorts.delete(input.port);
		});
		this.#starts.set(appId, start);
		return start;
	}

	async #startManaged(projectId: string, input: StartAppInput, agent: AppAgent, active: () => Promise<ActiveAppCheck>, appId: string): Promise<ProjectApp> {
		const app = this.#draft(projectId, input, agent, appId);
		const project = await this.options.store.require(projectId);
		const existing = project.apps?.records?.find(row => row.appId === appId);
		if (existing && !existing.managedProcess?.starting) return publishedApp(existing);
		await this.#checkPublication(app, active);
		if (!validManagedAppId(appId) || !input.command.trim() || input.command.length > 32768 || input.command.includes("\0")) {
			throw new ServerError("bad_request", "Give the app a nonempty command up to 32 KiB.");
		}
		const cwd = await realpath(resolve(project.path, input.cwd ?? ".")).catch(() => "");
		const canonical = async (path: string) => realpath(path).catch(() => path);
		const [root, dataDir, linked] = await Promise.all([canonical(project.path), canonical(this.options.store.projectDir(projectId)),
			this.#source.workspaces(project.path).then(paths => Promise.all(paths.map(canonical)))]);
		if (!cwd || !inAppWorkspace(cwd, root, dataDir, linked) || !(await stat(cwd)).isDirectory()) {
			throw new ServerError("bad_request", "Start the app inside this project or one of its workspaces.");
		}
		app.managedProcess = { command: input.command, cwd, logPath: this.#processes.logPath(appId), starting: true };
		const reserved = await this.#change(projectId, async document => {
			if (document.records?.some(row => row.appId === appId)) return { result: false, changed: false };
			await this.#checkPublication(app, active);
			if (document.records?.some(row => row.port === app.port && row.managedProcess?.starting) ||
				(await this.#listeningPorts())?.has(app.port) || !availableLoopbackPort(app.port)) {
				throw new ServerError("bad_request", `App port ${app.port} is already in use on this backend.`);
			}
			(document.records ??= []).unshift(app);
			return { result: true, changed: true };
		});
		let process: ManagedProcess | undefined;
		try {
			process = reserved ? await this.#processes.launch(appId, input.command, cwd) : await this.#identity(existing ?? app);
			const deadline = Date.now() + (this.options.startTimeoutMs ?? APP_START_TIMEOUT_MS);
			while (process && await this.#processes.alive(appId, process)) {
				if (await answersHttp(app.port) && await this.#ownsListener(app, process)) {
					this.#snapshot = undefined;
					return await this.#change(projectId, async document => {
						const row = this.#require(document, appId);
						if (row.state === "unpublished" || !row.managedProcess?.starting) throw new Error("The app was stopped during startup.");
						row.managedProcess.process = process!;
						delete row.managedProcess.starting;
						return { result: await this.#finishPublication(document, row, active), changed: true };
					});
				}
				if (Date.now() >= deadline) throw new Error(`The app did not answer on port ${app.port} in time.`);
				await Bun.sleep(125);
			}
			throw new Error("The app command exited before it answered HTTP.");
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (process) await this.#processes.stop(appId, process);
			await this.stopApp(projectId, appId, agent.publisher);
			const tail = await this.#processes.tail(appId, 8192);
			throw new ServerError("bad_request", `${reason}${tail ? `\n\nApp log tail:\n${tail}` : ""}`);
		}
	}

	async #ownsListener(app: AppRecord, owned: ManagedProcess): Promise<boolean> {
		const listeners = await this.#source.listeners();
		const pids = listeners?.filter(listener => listener.port === app.port).flatMap(listener => listener.pids) ?? [];
		if (!pids.length) return this.#processes.alive(app.appId, owned);
		const matching = await Promise.all(pids.map(async pid => owned.unit ? inManagedScope(pid, owned.unit) :
			(await processIdentity(pid, this.#processes.launchPath(app.appId)))?.pgid === owned.pgid));
		return matching.some(Boolean) && await this.#processes.alive(app.appId, owned);
	}

	#identity(app: AppRecord): Promise<ManagedProcess | undefined> {
		if (!app.managedProcess) return Promise.resolve(undefined);
		return app.managedProcess.process ? Promise.resolve(app.managedProcess.process) : this.#processes.identity(app.appId);
	}

	async #stopProcess(app: AppRecord): Promise<void> {
		const identity = await this.#identity(app);
		if (identity) await this.#processes.stop(app.appId, identity);
	}

	async readLog(projectId: string, appId: string, kilobytes = 32): Promise<string> {
		const project = await this.options.store.require(projectId);
		const app = this.#require(project.apps ?? {}, appId);
		if (!app.managedProcess) throw new ServerError("bad_request", "Kemiri did not start this app and has no log for it.");
		return this.#processes.tail(appId, Math.max(1, Math.min(128, kilobytes)) * 1024);
	}

	logPath(appId: string): string { return this.#processes.logPath(appId); }

	async allow(projectId: string, appId: string, active: () => Promise<ActiveAppCheck>): Promise<ProjectApp> {
		return this.#change(projectId, async document => {
			const app = this.#require(document, appId);
			if (app.state !== "pending" || app.managedProcess?.starting) throw new ServerError("bad_request", "Only apps waiting for approval can be allowed.");
			if (!(await active())(app)) throw new ServerError("bad_request", "This app's task or conversation is no longer active.");
			const settings = this.options.settings();
			if (settings.policy === "off") throw denied();
			if (!await answersHttp(app.port)) throw new ServerError("bad_request", `Nothing answered HTTP on port ${app.port} on this backend.`);
			this.#snapshot = undefined;
			const latest = this.options.settings();
			if (latest.policy === "off") throw denied();
			if (!(await active())(app)) throw new ServerError("bad_request", "This app's task or conversation is no longer active.");
			await this.#makeLive(app, latest);
			document.approved = true;
			this.#log(document, app, "allowed", "owner");
			return { result: publishedApp(app), changed: true };
		});
	}

	async unpublish(projectId: string, appId: string, actor: AppPublisher | "owner"): Promise<ProjectApp> {
		return this.#change(projectId, async document => {
			const app = this.#require(document, appId);
			if (app.managedProcess && actor !== "owner") throw new ServerError("bad_request", "Use app_stop for a managed app.");
			await this.#stopProcess(app);
			const changed = this.#stop(document, app, actor);
			return { result: publishedApp(app), changed };
		});
	}

	async stopApp(projectId: string, appId: string, actor: AppPublisher | "owner"): Promise<ProjectApp> {
		return this.#change(projectId, async document => {
			const app = this.#require(document, appId);
			await this.#stopProcess(app);
			const starting = app.managedProcess?.starting;
			if (app.managedProcess) delete app.managedProcess.starting;
			const changed = this.#stop(document, app, actor) || starting === true;
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
			for (const app of apps) if (!isActive(app)) {
				await this.#stopProcess(app);
				changed = this.#stop(document, app, "cleanup") || changed;
			}
			return { result: undefined, changed };
		});
	}

	#require(document: AppRegistryDocument, appId: string): AppRecord {
		const app = document.records?.find(record => record.appId === appId);
		if (!app) throw new ServerError("bad_request", "No app with that ID in this project.");
		return app;
	}

	async #listeningPorts(): Promise<ReadonlySet<number> | undefined> {
		const listeners = await this.#source.listeners();
		return listeners === null ? undefined : new Set(listeners.map(listener => listener.port));
	}

	async #makeLive(app: AppRecord, settings: AppSettings): Promise<void> {
		app.state = "live";
		if (settings.addresses.mode === "tailscale-serve") {
			await this.#serveMappings.resolve(app, settings.addresses, () => this.#listeningPorts());
			return;
		}
		let url: URL | null;
		try { url = appAddress(settings.addresses, app.port, app.path); }
		catch { throw new ServerError("bad_request", "The address template did not make a valid URL for this port."); }
		if (url && this.options.backendOrigins().some(origin => origin === url.origin)) {
			throw new ServerError("bad_request", "An app must have a different origin from Kemiri.");
		}
		app.mode = settings.addresses.mode;
		app.url = url?.href ?? null;
	}

	#stop(document: AppRegistryDocument, app: AppRecord, actor: AppActivity["actor"]): boolean {
		if (app.state === "unpublished") return false;
		app.state = "unpublished";
		delete app.stoppedAt;
		delete app.serveMapping;
		delete app.addressMessage;
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

	/** Backend Serve setup shares this queue with app allocation and removal. */
	serializeServeChange<T>(work: () => Promise<T>): Promise<T> {
		const operation = this.#pending.then(work);
		this.#pending = operation.catch(() => undefined);
		return operation;
	}

	#releaseOrphans(): Promise<void> {
		return this.serializeServeChange(async () => {
			const projects = await this.options.store.list();
			await this.#serveMappings.removeOrphans(projects.flatMap(project => project.apps?.records ?? []),
				this.options.settings().addresses.mode === "tailscale-serve");
		});
	}

	async #change<T>(projectId: string, update: (document: AppRegistryDocument) => Promise<{ result: T; changed: boolean; notify?: boolean }>): Promise<T> {
		const change = await this.serializeServeChange(() => this.options.store.updateAppRegistry(projectId, async document => {
			const ownedBefore = document.records?.filter(app => app.serveMapping).map(app => app.appId) ?? [];
			const change = await update(document);
			const release = ownedBefore.some(id => !document.records?.some(app => app.appId === id && app.serveMapping));
			return { result: { ...change, release }, changed: change.changed };
		}));
		if (change.release) await this.#releaseOrphans();
		if (change.changed || change.notify) this.options.changed(projectId);
		return change.result;
	}
}
