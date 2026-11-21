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

/** Optional version-1 project fields; older servers ignore this entire extension. */
export type AppRegistryDocument = {
	approved?: true;
	records?: ProjectApp[];
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

export function readAppRegistry(value: unknown, projectId: string): AppRegistryDocument | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const document = value as AppRegistryDocument;
	return {
		...(document.approved === true ? { approved: true } : {}),
		records: Array.isArray(document.records) ? document.records.filter(record =>
			Check(ProjectAppSchema, record) && record.projectId === projectId).map(record => ({
				...record,
				url: readAppUrl(record),
			})) : [],
		activity: Array.isArray(document.activity) ? document.activity : [],
	};
}
