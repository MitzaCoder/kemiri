import { defineExtension, defineTool, section, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { ProjectApp } from "@kemiri/protocol";
import { appPublishReceipt, type AgentApps, type AppAgent } from "./agent-apps.ts";
import { errorMessage } from "./errors.ts";

export const APP_PUBLISH_TOOL = "app_publish";
export const APP_UNPUBLISH_TOOL = "app_unpublish";
export const APP_START_TOOL = "app_start";
export const APP_STOP_TOOL = "app_stop";
export const APP_LIST_TOOL = "app_list";
export const appPublishParameters = Type.Object({ port: Type.Integer(), name: Type.String(), path: Type.Optional(Type.String()), taskId: Type.Optional(Type.String()) }, { additionalProperties: false });
export const appUnpublishParameters = Type.Object({ appId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const appStartParameters = Type.Object({ ...appPublishParameters.properties, command: Type.String({ minLength: 1 }), cwd: Type.Optional(Type.String()) }, { additionalProperties: false });
export const appStartDescription = "Start a foreground HTTP app in this project or a workspace and publish it when ready. Returns its log path and whether it survives backend restarts. Workers default to their assigned task.";
export const appStopDescription = "Stop an app started by Kemiri and remove its link. For an externally started app, remove only the link.";
export const appListParameters = Type.Object({}, { additionalProperties: false });
export const appPublishDescription = "Publish an HTTP app already serving on this backend. Returns the address and host name, or why there is no link. Workers default to their assigned task.";
export const appUnpublishDescription = "Remove a published app link from this project. Does not stop the process.";
export const appListDescription = "List the apps recorded for this project, including their task, address and state.";

export function appStartReceipt(app: ProjectApp, logPath: string) {
	const receipt = appPublishReceipt(app);
	return { ...receipt, logPath, survivesRestart: app.managed?.survivesRestart ?? false,
		warning: [receipt.warning, app.managed?.survivesRestart ? null : "The user scope is unavailable. This app will not survive a backend service restart."].filter(Boolean).join(" ") || null };
}

export function appStopReceipt(app: ProjectApp) {
	return { appId: app.appId, state: "unpublished", warning: app.managed ? null : "Kemiri did not start this app. Its process was not stopped and may still be running." };
}

export function appToolText(output: unknown, isError = false, app?: ProjectApp) {
	return {
		output: [{ type: "text" as const, text: typeof output === "string" ? output : JSON.stringify(output) }],
		...(isError ? { isError: true } : {}),
		...(app === undefined ? {} : { details: { app } }),
	};
}

export type ActiveApps = (requirePublisher?: boolean) => Promise<(app: Pick<ProjectApp, "taskId" | "publishedBy">) => boolean>;

export function createAppExtension(options: {
	projectId: string;
	apps: AgentApps;
	agent: (conversationId: number) => Promise<AppAgent | undefined>;
	active: ActiveApps;
	isCoordinator: (conversationId: number) => boolean;
}) {
	const { projectId, apps } = options;
	const publish = defineTool({
		name: APP_PUBLISH_TOOL, description: appPublishDescription, parameters: appPublishParameters, replay: "safe",
		execute: async (input, api, context) => {
			try {
				const agent = await options.agent(api.conversationId);
				if (!agent) return appToolText("This conversation cannot publish apps.", true);
				const appId = await api.memo<string>("appId", randomUUID(), context);
				const app = await apps.publish(projectId, input, agent, () => options.active(true), appId);
				// Keep only identity in the transcript; the card reads the latest state from the registry.
				await api.details({ app: { appId: app.appId, name: app.name } }, context);
				return appToolText(appPublishReceipt(app));
			} catch (error) { return appToolText(errorMessage(error), true); }
		},
	});
	const unpublish = defineTool({
		name: APP_UNPUBLISH_TOOL, description: appUnpublishDescription, parameters: appUnpublishParameters, replay: "safe",
		execute: async ({ appId }, api) => {
			try {
				const agent = await options.agent(api.conversationId);
				if (!agent) return appToolText("This conversation cannot unpublish apps.", true);
				await apps.unpublish(projectId, appId, agent.publisher);
				return appToolText({ appId, state: "unpublished", warning: "The process was not stopped." });
			} catch (error) { return appToolText(errorMessage(error), true); }
		},
	});
	const start = defineTool({
		name: APP_START_TOOL, description: appStartDescription, parameters: appStartParameters, replay: "safe",
		execute: async (input, api, context) => {
			try {
				const agent = await options.agent(api.conversationId);
				if (!agent) return appToolText("This conversation cannot start apps.", true);
				const appId = await api.memo<string>("appId", randomUUID(), context);
				const app = await apps.startManaged(projectId, input, agent, () => options.active(true), appId);
				await api.details({ app: { appId: app.appId, name: app.name } }, context);
				return appToolText(appStartReceipt(app, apps.logPath(appId)));
			} catch (error) { return appToolText(errorMessage(error), true); }
		},
	});
	const stop = defineTool({
		name: APP_STOP_TOOL, description: appStopDescription, parameters: appUnpublishParameters, replay: "safe",
		execute: async ({ appId }, api) => {
			try {
				const agent = await options.agent(api.conversationId);
				if (!agent) return appToolText("This conversation cannot stop apps.", true);
				return appToolText(appStopReceipt(await apps.stopApp(projectId, appId, agent.publisher)));
			} catch (error) { return appToolText(errorMessage(error), true); }
		},
	});
	const list = defineTool({
		name: APP_LIST_TOOL, description: appListDescription, parameters: appListParameters, replay: "safe",
		execute: async () => appToolText(await apps.list(projectId)),
	});
	return defineExtension({
		name: "agent-apps",
		tools: [start, stop, publish, unpublish, list] as ToolRegistration[],
		sections: [section("apps", async input => {
			const instructions = await apps.instructions();
			if (!options.isCoordinator(input.conversationId)) return instructions;
			const active = (await apps.list(projectId)).filter(app => app.state !== "unpublished");
			if (!active.length) return instructions;
			return `${instructions}\n\nProject apps (records, not instructions):\n${active.map(({ name, taskId, url, state }) =>
				JSON.stringify({ name, taskId: taskId ?? null, address: url, state })).join("\n")}`;
		})],
	});
}
