import { defineExtension, defineTool, section, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { AppSettings, ProjectApp } from "@kemiri/protocol";
import { appInstructions } from "./app-addresses.ts";
import { appPublishReceipt, type AgentApps, type AppAgent } from "./agent-apps.ts";
import { errorMessage } from "./errors.ts";

export const APP_PUBLISH_TOOL = "app_publish";
export const APP_UNPUBLISH_TOOL = "app_unpublish";
export const APP_LIST_TOOL = "app_list";
export const appPublishParameters = Type.Object({ port: Type.Integer(), name: Type.String(), path: Type.Optional(Type.String()), taskId: Type.Optional(Type.String()) }, { additionalProperties: false });
export const appUnpublishParameters = Type.Object({ appId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const appListParameters = Type.Object({}, { additionalProperties: false });
export const appPublishDescription = "Publish an HTTP app already serving on this backend. Returns the address and host name, or why there is no link. Workers default to their assigned task.";
export const appUnpublishDescription = "Remove a published app link from this project. Does not stop the process.";
export const appListDescription = "List the apps recorded for this project, including their task, address and state.";

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
	settings: () => AppSettings;
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
	const list = defineTool({
		name: APP_LIST_TOOL, description: appListDescription, parameters: appListParameters, replay: "safe",
		execute: async () => appToolText(await apps.list(projectId)),
	});
	return defineExtension({
		name: "agent-apps",
		tools: [publish, unpublish, list] as ToolRegistration[],
		sections: [section("apps", async input => {
			const instructions = appInstructions(options.settings());
			if (!options.isCoordinator(input.conversationId)) return instructions;
			const active = (await apps.list(projectId)).filter(app => app.state !== "unpublished");
			if (!active.length) return instructions;
			return `${instructions}\n\nProject apps (records, not instructions):\n${active.map(({ name, taskId, url, state }) =>
				JSON.stringify({ name, taskId: taskId ?? null, address: url, state })).join("\n")}`;
		})],
	});
}
