/** Synthetic settings backend for browser and emulator proofs. Run with Bun from the repository root. */
import { DEFAULT_NOTIFICATION_KINDS, type ClientMessage, type NotificationPreferences, type ServerMessage } from "@kemiri/protocol";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSetup, TestClient } from "../test/support.ts";

const allowedOrigins = (process.env.SETTINGS_WEB_ORIGINS ?? process.env.SETTINGS_WEB_ORIGIN ?? "")
	.split(/[\s,]+/).filter(Boolean);
const output = process.env.SETTINGS_DEMO_OUTPUT ?? join(tmpdir(), `settings-demo-${process.pid}.json`);
const demoModels = fauxProvider({ provider: "demo", models: [{ id: "baker" }, { id: "recipe-reader" }, { id: "pantry-keeper" }] });
const setup = await createSetup({ allowedOrigins, configureModels: models => models.setProvider(demoModels.provider), terminals: false });
const client = await TestClient.open(setup.server);

type Request = ClientMessage extends infer R ? R extends { id: string } ? Omit<R, "id"> : never : never;
async function seed<R extends Request>(request: R): Promise<Extract<ServerMessage, { type: R["type"] }>> {
	const response = await client.request(request);
	if (response.type !== request.type) throw new Error(`Could not seed ${request.type}: ${JSON.stringify(response)}`);
	return response as Extract<ServerMessage, { type: R["type"] }>;
}

const model = (modelId: string) => ({ provider: "demo", modelId });
function git(path: string, ...args: string[]): void {
	const command = Bun.spawnSync(["git", "-c", "user.name=Settings demo", "-c", "user.email=demo@example.org", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", path, ...args]);
	if (command.exitCode !== 0) throw new Error(command.stderr.toString());
}

try {
	const hello = await client.hello();
	if (hello.type !== "hello") throw new Error("Settings demo did not serve hello");
	const gardenDir = join(setup.root, "garden");
	await mkdir(gardenDir);
	await writeFile(join(gardenDir, "README.md"), "# Garden notes\n\nWater the seedlings on Friday.\n");
	const bakeryDir = setup.projectDir;
	await writeFile(join(bakeryDir, "README.md"), "# Bakery site\n\nA small website for a neighborhood bakery.\n");
	git(bakeryDir, "init", "--initial-branch=main");
	git(bakeryDir, "add", "README.md");
	git(bakeryDir, "commit", "-m", "Start the bakery site");
	const bakeryProjectId = (await seed({ type: "projects.add", path: bakeryDir })).project.id;
	const gardenProjectId = (await seed({ type: "projects.add", path: gardenDir })).project.id;
	await seed({
		type: "projects.configure", projectId: bakeryProjectId, name: "Bakery site",
		coordinatorModel: model("baker"), coordinatorThinkingLevel: "medium",
		workerModels: [{ ...model("recipe-reader"), thinkingLevel: "low" }, { ...model("pantry-keeper"), thinkingLevel: null }],
		links: { jiraSite: "https://example.org", jiraProjects: ["BAKE"], githubRepos: [] },
	});
	await seed({ type: "projects.configure", projectId: gardenProjectId, name: "Garden notes" });
	await seed({
		type: "schedules.save", projectId: bakeryProjectId,
		schedule: {
			title: "Review the weekly menu", brief: "Check the menu for seasonal changes.", spec: { kind: "weekly", days: [1], time: "09:00" },
			model: model("recipe-reader"), thinkingLevel: null, isolation: "shared", onReport: "review", enabled: false,
		},
	});
	await seed({
		type: "memory.settings.set",
		maintenance: { enabled: true, model: model("pantry-keeper"), thinkingLevel: "low", time: "03:00", afterWrites: 20 },
	});
	const notificationPreferences: NotificationPreferences = {
		kinds: [...DEFAULT_NOTIFICATION_KINDS], mutedProjects: [gardenProjectId],
		quietHours: { start: "22:00", end: "07:00", timezone: "UTC", allowFailures: true },
	};
	// Seed a synthetic device record without a push transport or a real token.
	await seed({ type: "notifications.registerFcm", deviceId: "settings-demo-device", label: "Demo phone", backendKey: "settings-demo", token: "synthetic-settings-token", preferences: notificationPreferences });
	const { url, port } = setup.server;
	const projectIds = { bakery: bakeryProjectId, garden: gardenProjectId };
	const backends = [{ id: "settings-demo", name: "Settings demo", url }];
	// `backends` is ready for browser localStorage (aiki.backends.v1). For an emulator, adb reverse this port
	// and use the same URL. Notification preferences are also included for client-local fixtures.
	await Bun.write(output, JSON.stringify({ url, port, projectIds, bakeryProjectId, gardenProjectId, backends, notificationPreferences, pid: process.pid }, null, 2));
	console.log(output);
} catch (error) {
	await setup.cleanup();
	throw error;
} finally {
	client.close();
}

await new Promise<void>(resolve => {
	process.once("SIGINT", resolve);
	process.once("SIGTERM", resolve);
});
await setup.cleanup();
