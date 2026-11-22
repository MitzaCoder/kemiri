import { ProjectAppSchema, type AppPublisher, type ProjectApp } from "@kemiri/protocol";
import { isAppServeMapping } from "./app-serve-mappings.ts";
import { validManagedAppId, validManagedProcess, type ManagedApp } from "./managed-app-process.ts";
import type { ServeMapping } from "./tailscale.ts";
import { Check } from "typebox/value";

export type AppActivity = {
	kind: "published" | "allowed" | "unpublished";
	appId: string;
	taskId?: string;
	publishedBy: AppPublisher;
	actor: AppPublisher | "owner" | "cleanup";
	at: string;
};

/** A stopped app stays encoded as live on disk so a Stage 1 rollback can still read the row. */
export type AppRecord = ProjectApp & { stoppedAt?: string | undefined; unpublishedAt?: string | undefined; serveMapping?: ServeMapping; managedProcess?: ManagedApp };

/** Optional version-1 project fields; older servers ignore this entire extension. */
export type AppRegistryDocument = {
	approved?: true;
	records?: AppRecord[];
	ignoredPorts?: number[];
	activity?: AppActivity[];
};

/** Park Serve records as off on disk so previous releases keep the row without exposing a stale link. */
export function encodeProjectAppRegistry<T extends { apps?: AppRegistryDocument }>(project: T) {
	if (!project.apps?.records?.some(app => app.mode === "tailscale-serve")) return project;
	return { ...project, apps: { ...project.apps, records: project.apps.records.map(app => app.mode === "tailscale-serve"
		? { ...app, mode: "off", tailscaleServe: true } : app) } };
}

function readAppUrl(record: ProjectApp): string | null {
	if (record.state !== "live" || record.mode === "off" || typeof record.url !== "string") return null;
	try {
		const url = new URL(record.url);
		if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) return url.href;
	} catch { /* Keep the app record without a malformed link. */ }
	return null;
}

function validTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function readAppRegistry(value: unknown, projectId: string): AppRegistryDocument | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const document = value as AppRegistryDocument;
	const activity = Array.isArray(document.activity) ? document.activity.filter(event => event && validTimestamp(event.at)) : [];
	const unpublishedAt = new Map(activity.filter(event => event.kind === "unpublished").map(event => [event.appId, event.at]));
	return {
		...(document.approved === true ? { approved: true } : {}),
		records: Array.isArray(document.records) ? document.records.filter(record =>
			Check(ProjectAppSchema, record) && record.projectId === projectId).map(saved => {
				const { tailscaleServe, serveMapping, managedProcess, managed: _, ...record } = saved as AppRecord & { tailscaleServe?: true };
				if (record.mode === "off" && tailscaleServe === true) record.mode = "tailscale-serve";
				return {
					...record,
					...(managedProcess && validManagedAppId(record.appId) && typeof managedProcess.command === "string" &&
						typeof managedProcess.cwd === "string" && typeof managedProcess.logPath === "string" ? { managedProcess: {
							command: managedProcess.command, cwd: managedProcess.cwd, logPath: managedProcess.logPath,
							...(managedProcess.starting === true ? { starting: true as const } : {}),
							...(validManagedProcess(managedProcess.process, record.appId) ? { process: managedProcess.process } : {}),
						} } : {}),
					...(record.mode === "tailscale-serve" && isAppServeMapping(serveMapping, record.port) ? { serveMapping } : {}),
					url: readAppUrl(record),
					...(record.state === "live" && validTimestamp(record.stoppedAt) ? { stoppedAt: record.stoppedAt } : { stoppedAt: undefined }),
					...(record.state === "unpublished" ? { unpublishedAt: validTimestamp(record.unpublishedAt) ? record.unpublishedAt : unpublishedAt.get(record.appId) ?? record.createdAt } : { unpublishedAt: undefined }),
				};
			}) : [],
		activity,
		ignoredPorts: Array.isArray(document.ignoredPorts) ? [...new Set(document.ignoredPorts.filter(port => Number.isInteger(port) && port >= 1024 && port <= 65535))] : [],
	};
}
