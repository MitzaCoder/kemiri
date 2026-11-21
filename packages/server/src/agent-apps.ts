import { request } from "node:http";
import { randomUUID } from "node:crypto";
import type { AppPublisher, AppSettings, ProjectApp } from "@kemiri/protocol";
import { appAddress } from "./app-addresses.ts";
import type { AppActivity, AppRegistryDocument } from "./app-registry-document.ts";
import { ServerError } from "./errors.ts";
import type { ProjectStore } from "./projects.ts";

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
			app.state === "unpublished" ? "This app was unpublished." : !app.url ? NO_ADDRESS : null };
}

export class AgentApps {
	constructor(readonly options: AgentAppsOptions) {}

	async list(projectId: string): Promise<ProjectApp[]> {
		const project = await this.options.store.require(projectId);
		return project.apps?.records ?? [];
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
		const existing = (await this.list(projectId)).find(app => app.appId === appId);
		if (existing) return existing;
		if (!await answersHttp(port)) throw new ServerError("bad_request", `Nothing answered HTTP on port ${port} on this backend.`);
		return this.#change(projectId, async document => {
			const existing = document.records?.find(app => app.appId === appId);
			if (existing) return { result: existing, changed: false };
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
			return { result: app, changed: this.#stop(document, app, actor) };
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

	#require(document: AppRegistryDocument, appId: string): ProjectApp {
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

	#stop(document: AppRegistryDocument, app: ProjectApp, actor: AppActivity["actor"]): boolean {
		if (app.state === "unpublished") return false;
		app.state = "unpublished";
		app.url = null;
		this.#log(document, app, "unpublished", actor);
		return true;
	}

	#timestamp(): string { return new Date(this.options.now?.() ?? Date.now()).toISOString(); }

	#log(document: AppRegistryDocument, app: ProjectApp, kind: AppActivity["kind"], actor: AppActivity["actor"]): void {
		(document.activity ??= []).push({ kind, appId: app.appId, publishedBy: app.publishedBy, actor, at: this.#timestamp(),
			...(app.taskId === undefined ? {} : { taskId: app.taskId }) });
	}

	async #change<T>(projectId: string, update: (document: AppRegistryDocument) => Promise<{ result: T; changed: boolean }>): Promise<T> {
		const change = await this.options.store.updateAppRegistry(projectId, async document => {
			const change = await update(document);
			return { result: change, changed: change.changed };
		});
		if (change.changed) this.options.changed(projectId);
		return change.result;
	}
}
