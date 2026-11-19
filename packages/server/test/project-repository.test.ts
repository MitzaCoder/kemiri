import { expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HARNESS_FEATURES, LEGACY_HARNESS_FEATURES } from "@kemiri/protocol";
import { createSetup, TestClient } from "./support.ts";

it("detects repository markers in the project or an ancestor and refreshes on list", async () => {
	const setup = await createSetup();
	const client = await TestClient.open(setup.server);
	try {
		const hello = await client.hello();
		if (hello.type !== "hello") throw new Error("Missing hello");
		for (const feature of ["project-repository", "worker-picker-project-default", "memory-maintenance-enabled"] as const) {
			expect(hello.features).toContain(feature);
			expect(LEGACY_HARNESS_FEATURES).not.toContain(feature);
		}
		const fixtures = [
			{ folder: "ordinary", marker: ".git", directory: true, nested: false },
			{ folder: "worktree", marker: ".git", directory: false, nested: true },
			{ folder: "jj", marker: ".jj", directory: true, nested: true },
			{ folder: "plain", marker: null, directory: false, nested: false },
		];
		for (const { folder, marker, directory, nested } of fixtures) {
			const root = join(setup.root, folder);
			const path = nested ? join(root, "src") : root;
			await mkdir(path, { recursive: true });
			if (marker !== null) {
				if (directory) await mkdir(join(root, marker));
				else await writeFile(join(root, marker), "gitdir: ../metadata\n");
			}
			const added = await client.request({ type: "projects.add", path });
			if (added.type !== "projects.add") throw new Error("Missing project");
			expect(added.project.repository).toBe(marker !== null);
		}
		await mkdir(join(setup.root, "plain", ".git"));
		const listed = await client.request({ type: "projects.list" });
		if (listed.type !== "projects.list") throw new Error("Missing project list");
		expect(listed.projects).toHaveLength(4);
		expect(listed.projects.every(project => project.repository)).toBe(true);
	} finally {
		client.close();
		await setup.cleanup();
	}
});

it("keeps the old wire behavior when the new features are disabled", async () => {
	const setup = await createSetup({ features: HARNESS_FEATURES.filter(feature =>
		feature !== "project-repository" && feature !== "worker-picker-project-default" && feature !== "memory-maintenance-enabled") });
	const client = await TestClient.open(setup.server);
	try {
		await client.hello();
		const added = await client.request({ type: "projects.add", path: setup.projectDir });
		if (added.type !== "projects.add") throw new Error("Missing project");
		const projectId = added.project.id;
		expect(added.project).not.toHaveProperty("repository");
		const model = { provider: "faux", modelId: "faux-1" };
		const defaults = { model, thinkingLevel: "low" };
		expect(await client.request({ type: "workers.defaults.set", projectId, defaults })).toMatchObject({ defaults });
		expect((await setup.server.manager.requireProject(projectId)).workerModels).toEqual([]);
		expect(await client.request({ type: "workers.list", projectId })).toMatchObject({ defaults });
		const maintenance = { model, thinkingLevel: null, time: "03:00", afterWrites: 20 };
		const settings = await client.request({ type: "memory.settings.set", maintenance: { ...maintenance, enabled: false } });
		if (settings.type !== "memory.settings.set") throw new Error("Missing settings");
		expect(settings.maintenance).toEqual(maintenance);
		expect(await client.request({ type: "memory.status", scope: "global" })).toMatchObject({ status: { nextMaintenanceAt: expect.any(String) } });
	} finally {
		client.close();
		await setup.cleanup();
	}
});
