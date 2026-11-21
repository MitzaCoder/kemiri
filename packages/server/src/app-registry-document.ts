import { ProjectAppSchema, type AppPublisher, type ProjectApp } from "@kemiri/protocol";
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
export type AppRecord = ProjectApp & { stoppedAt?: string | undefined; unpublishedAt?: string | undefined };

/** Optional version-1 project fields; older servers ignore this entire extension. */
export type AppRegistryDocument = {
	approved?: true;
	records?: AppRecord[];
	ignoredPorts?: number[];
	activity?: AppActivity[];
};

function readAppUrl(record: ProjectApp): string | null {
	if (record.state !== "live" || record.mode === "off" || record.url === null) return null;
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
			Check(ProjectAppSchema, record) && record.projectId === projectId).map(record => ({
				...record,
				url: readAppUrl(record),
				...(record.state === "live" && validTimestamp(record.stoppedAt) ? { stoppedAt: record.stoppedAt } : { stoppedAt: undefined }),
				...(record.state === "unpublished" ? { unpublishedAt: validTimestamp(record.unpublishedAt) ? record.unpublishedAt : unpublishedAt.get(record.appId) ?? record.createdAt } : { unpublishedAt: undefined }),
			})) : [],
		activity,
		ignoredPorts: Array.isArray(document.ignoredPorts) ? [...new Set(document.ignoredPorts.filter(port => Number.isInteger(port) && port >= 1024 && port <= 65535))] : [],
	};
}
