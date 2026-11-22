import { expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ARTIFACT_LIVING_VERSION_LIMIT } from "@kemiri/protocol";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, ARTIFACT_VERSION_LIMIT } from "../src/artifacts.ts";
import { BoardDoc } from "../src/board.ts";
import { createSetup, errorOf, TestClient } from "./support.ts";

test("continuations keep the home identity and living retention after the first later version is pruned", async () => {
	const root = await mkdtemp(join(tmpdir(), "artifact-continuation-"));
	try {
		const store = new ArtifactStore({ dataDir: root });
		const original = join(root, "report.md");
		const revised = join(root, "revised.md");
		await writeFile(original, "# Original");
		await writeFile(revised, "# Revision");
		const input = { projectId: "p", threadId: "main", workerId: null, sourcePath: original, taskId: "T1" };
		const first = await store.save({ ...input, title: "Living report", note: "Summary", tags: ["web"] });
		const living = (await store.update("p", first.id, { living: true })).living;
		const later = { ...input, threadId: "later", workerId: "worker", sourcePath: revised, taskId: "T2" };
		const second = await store.save({ ...later, continueArtifactId: first.id, artifactId: "operation", liveRun: { conversationId: 2, runId: "run" } });
		expect(second).toMatchObject({ id: first.id, name: "revised.md", title: "Living report", note: "Summary", tags: ["web"], taskId: "T1", madeForTaskId: "T2", laterTaskIds: ["T2"], living });
		expect(second.versions?.[1]).toHaveProperty("madeForTaskId", "T2");
		expect(second.versions?.[1]).not.toHaveProperty("living");
		expect(await store.save({ ...later, continueArtifactId: first.id, artifactId: "operation" })).toHaveProperty("version", 2);
		expect(await store.taskSaves("p")).toMatchObject([{ taskId: "T2" }]);
		for (const taskId of ["T1", "T2"]) expect(await store.list("p", { taskId })).toMatchObject([{ id: first.id }]);
		expect(await store.save(later)).toMatchObject({ id: first.id, version: 3, madeForTaskId: "T2", laterTaskIds: ["T2"] });
		let last = await store.save({ ...later, taskId: "T3", continueArtifactId: first.id });
		for (let i = 0; i < ARTIFACT_LIVING_VERSION_LIMIT; i++) last = await store.save({ ...input, sourcePath: revised });
		expect(last.versions).toHaveLength(ARTIFACT_LIVING_VERSION_LIMIT);
		expect(last.versions?.[0]?.version).toBe(5);
		expect(last.madeForTaskId).toBeUndefined();
		expect(last.laterTaskIds).toEqual(["T2", "T3"]);
		expect(await store.list("p", { taskId: "T2" })).toMatchObject([{ id: first.id }]);
		expect((await store.update("p", first.id, { living: false })).versions).toHaveLength(ARTIFACT_LIVING_VERSION_LIMIT);
		const next = await store.save({ ...input, sourcePath: revised });
		expect(next.versions).toHaveLength(ARTIFACT_VERSION_LIMIT);
		expect(next.version).toBe(last.version! + 1);
		expect(next.laterTaskIds).toEqual(["T2", "T3"]);
		// An existing home-task artifact with the same name wins over a later-task match.
		const other = await store.save({ ...later, sourcePath: original });
		await store.save({ ...later, continueArtifactId: other.id });
		expect(await store.save(later)).toMatchObject({ id: other.id, taskId: "T2", version: 3 });
		// Cross-chat continuation of a taskless artifact does not move its implicit conversation scope.
		const chat = await store.save({ ...input, taskId: null });
		await store.save({ ...later, continueArtifactId: chat.id });
		expect(await store.save({ ...input, taskId: null, sourcePath: revised })).toMatchObject({ id: chat.id, taskId: null, version: 3 });
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("pinned HTML keeps every retained version without changing its living mark", async () => {
	const root = await mkdtemp(join(tmpdir(), "artifact-pin-retention-"));
	try {
		const store = new ArtifactStore({ dataDir: root });
		const sourcePath = join(root, "guide.html");
		const plainPath = join(root, "guide.txt");
		await writeFile(sourcePath, "<h1>First edition</h1>");
		await writeFile(plainPath, "Not HTML");
		const input = { projectId: "p", threadId: "main", workerId: null, sourcePath, taskId: "T1" };
		const first = await store.save(input);
		await store.update("p", first.id, { living: true, pinned: true });
		const later = { ...input, taskId: "T2", threadId: "later", continueArtifactId: first.id };
		await expect(store.save({ ...later, sourcePath: plainPath })).rejects.toMatchObject({ code: "bad_request" });
		for (let i = 0; i <= ARTIFACT_LIVING_VERSION_LIMIT; i++) await store.save(later);
		// Pinning applies to the root even when another coordinator or task saves a new version.
		const reopened = new ArtifactStore({ dataDir: root });
		const saved = await reopened.require("p", first.id);
		expect(saved).toMatchObject({ pinned: true, taskId: "T1", versionCount: ARTIFACT_LIVING_VERSION_LIMIT + 2 });
		expect(saved.versions).toHaveLength(ARTIFACT_LIVING_VERSION_LIMIT + 2);
		expect(saved.versions?.[0]).not.toHaveProperty("pinned");
		const oldest = await reopened.require("p", `${first.id}~1`);
		expect(await Bun.file(reopened.filePath(oldest)).text()).toBe("<h1>First edition</h1>");
		const unpinned = await reopened.update("p", first.id, { pinned: false });
		expect(unpinned.pinned).toBeUndefined();
		expect(unpinned.createdAt).toBe(saved.createdAt);
		expect(unpinned.versions).toHaveLength(ARTIFACT_LIVING_VERSION_LIMIT + 2);
		expect(unpinned.living).toEqual(saved.living);
		expect((await reopened.save(later)).versions).toHaveLength(ARTIFACT_LIVING_VERSION_LIMIT);
		expect(await Bun.file(reopened.filePath(oldest)).exists()).toBe(false);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("project catalogue omits snapshots, and a remote client sees pins and unpins", async () => {
	const setup = await createSetup({ terminals: false });
	const writer = await TestClient.open(setup.server);
	const reader = await TestClient.open(setup.server);
	try {
		expect(await writer.hello()).toMatchObject({ features: expect.arrayContaining(["project-artifacts"]) });
		await reader.hello();
		const project = await writer.request({ type: "projects.add", path: setup.projectDir });
		if (project.type !== "projects.add") throw errorOf(project);
		const projectId = project.project.id;
		const store = setup.server.artifacts;
		const save = async (file: string) => {
			const sourcePath = join(setup.projectDir, file);
			await writeFile(sourcePath, "<h1>Garden map</h1>");
			return store.save({ projectId, sourcePath, taskId: null, threadId: "main", workerId: null });
		};
		const html = await save("map.html");
		const text = await save("map.txt");
		const update = { type: "artifacts.update", projectId, artifactId: html.id } as const;
		expect(errorOf(await writer.request({ ...update, artifactId: text.id, pinned: true })).code).toBe("bad_request");
		expect(errorOf(await writer.request({ ...update, artifactId: `${html.id}~1`, pinned: true })).code).toBe("unknown_artifact");
		const pinned = await writer.request({ ...update, pinned: true });
		expect(pinned).toMatchObject({ artifact: { id: html.id, pinned: true, createdAt: html.createdAt } });
		await reader.waitFor(event => event.type === "artifacts.changed" && event.projectId === projectId && event.artifact.id === html.id && event.artifact.pinned === true);
		const catalogue = await reader.request({ type: "artifacts.list", projectId, catalogue: true });
		if (catalogue.type !== "artifacts.list") throw errorOf(catalogue);
		expect(catalogue.artifacts.map(row => row.id)).toEqual([text.id, html.id]);
		expect(catalogue.artifacts[1]).toHaveProperty("pinned", true);
		expect(catalogue.artifacts[1]).not.toHaveProperty("versions");
		const detail = await reader.request({ type: "artifacts.list", projectId, artifactId: html.id });
		expect(detail).toMatchObject({ artifacts: [{ id: html.id, versions: [{ id: `${html.id}~1` }] }] });
		await writer.request({ ...update, pinned: false, tags: ["unpinned"] });
		await reader.waitFor(event => event.type === "artifacts.changed" && event.projectId === projectId && event.artifact.id === html.id && event.artifact.pinned === undefined && !event.deleted && event.artifact.tags?.includes("unpinned") === true);
	} finally {
		writer.close(); reader.close();
		await setup.cleanup();
	}
});

test("library pages archived projects and task facts; trail reads decisions and feedback across tasks", async () => {
	let now = Date.parse("2026-01-01T00:00:00Z");
	const setup = await createSetup({ now: () => now, terminals: false });
	const client = await TestClient.open(setup.server);
	try {
		const hello = await client.hello();
		expect(hello).toMatchObject({ features: expect.arrayContaining(["artifact-library"]) });
		const project = await client.request({ type: "projects.add", path: setup.projectDir });
		const archivePath = join(setup.root, "old-project");
		await mkdir(archivePath);
		const archived = await client.request({ type: "projects.add", path: archivePath });
		if (project.type !== "projects.add" || archived.type !== "projects.add") throw new Error("Project creation failed");
		const projectId = project.project.id;
		const archivedId = archived.project.id;
		const { runtime } = await setup.server.manager.open(archivedId);
		const task = async (title: string, status: "done" | "todo") => runtime.board.saveTask({ task: {
			title, status, description: "", acceptance: null, blockedBy: [], blockedReason: null, writeScopes: [],
		} }, "user");
		const home = await task("Publish the seed guide", "done");
		const later = await task("Revise the seed guide", "todo");
		const unrelated = await task("Check the garden plan", "todo");
		await runtime.board.writeReport(change => runtime.harness.commit(change, BACKGROUND_CONTEXT), {
			taskId: home.id, sections: { summary: "The seed guide is ready." }, by: { author: "coordinator", threadId: null, workerId: null },
		}, "seed-guide-report");
		await runtime.harness.commit(async (tx) => {
			const board = await tx.doc(BoardDoc, runtime.conversation.id);
			board.decisions.push(
				{ id: "D1", at: "2026-01-01T00:00:00Z", taskId: home.id, text: "Keep a print copy", why: null },
				{ id: "D2", at: "2026-01-02T00:00:00Z", taskId: home.id, text: "Use large labels", why: "Easier to read" },
				{ id: "D3", at: "2026-01-03T00:00:00Z", taskId: unrelated.id, text: "Separate decision", why: null },
			);
		}, BACKGROUND_CONTEXT);
		const store = setup.server.manager.artifacts;
		const input = { projectId: archivedId, sourcePath: join(setup.projectDir, "README.md"), taskId: home.id, threadId: "main", workerId: null };
		const first = await store.save(input);
		const comment = async (taskId: string, text: string) => runtime.board.recordFeedback({ taskId, text, images: 0, threadId: "main", requestId: text });
		const reviewed = await comment(unrelated.id, `Please clarify (artifact ${first.id}~1, README.md)`);
		await runtime.board.setFeedback({ taskId: unrelated.id, feedbackId: reviewed.id, state: "addressed", note: "Clarified in the guide." });
		now += 8 * 24 * 60 * 60 * 1000;
		await comment(home.id, `Keep this (artifact ${first.id})`);
		await comment(home.id, `Wrong ID (artifact ${first.id}-other)`);
		await store.save({ ...input, taskId: later.id, continueArtifactId: first.id });
		const archivedResponse = await client.request({ type: "projects.configure", projectId: archivedId, name: "Old garden", archived: true });
		expect(archivedResponse.type).toBe("projects.configure");
		now++;
		const newest = await store.save({ ...input, projectId, taskId: "T999" });
		const page = await client.request({ type: "artifacts.library", limit: 1 });
		expect(page).toMatchObject({ type: "artifacts.library", artifacts: [{ id: newest.id }], tasks: [], projects: [{ id: projectId, archived: false }], nextBefore: newest.createdAt });
		const secondPage = await client.request({ type: "artifacts.library", limit: 1, before: newest.createdAt });
		expect(secondPage).toMatchObject({
			type: "artifacts.library", artifacts: [{ id: first.id, version: 2, versions: [{ version: 1 }, { version: 2 }] }], nextBefore: null,
			projects: [{ id: archivedId, name: "Old garden", archived: true }],
			tasks: expect.arrayContaining([{ projectId: archivedId, id: home.id, title: home.title, status: "done", archived: true, settledAt: home.settledAt, summary: "The seed guide is ready." },
				{ projectId: archivedId, id: later.id, title: later.title, status: "todo", archived: false, settledAt: null }]),
		});
		const snapshot = spyOn(runtime.harness, "snapshot");
		try {
			expect(await client.request({ type: "artifacts.library", projectIds: [archivedId] })).toMatchObject({ artifacts: [{ id: first.id }], nextBefore: null });
			expect(snapshot.mock.calls.some(([token]) => Object.is(token, BoardDoc))).toBe(true);
		} finally {
			snapshot.mockRestore();
		}
		const trail = await client.request({ type: "artifacts.trail", projectId: archivedId, artifactId: `${first.id}~99` });
		expect(trail).toMatchObject({ type: "artifacts.trail", artifact: { id: first.id },
			tasks: [{ id: home.id, decisions: [{ id: "D2", why: "Easier to read" }, { id: "D1", why: null }] }, { id: later.id, decisions: [] }],
			comments: [{ taskId: unrelated.id, feedbackId: reviewed.id, version: 1, state: "addressed", note: "Clarified in the guide." }, { taskId: home.id, version: null, state: "open", note: null }],
		});
		expect(errorOf(await client.request({ type: "artifacts.trail", projectId: archivedId, artifactId: "missing" })).code).toBe("unknown_artifact");
		const update = { type: "artifacts.update", projectId: archivedId, artifactId: first.id } as const;
		expect(errorOf(await client.request(update)).code).toBe("bad_request");
		const since = new Date(now).toISOString();
		expect(await client.request({ ...update, living: true, tags: [" Web ", "WEB"] })).toMatchObject({ artifact: { living: { since }, tags: ["web"] } });
		await client.waitFor(message => message.type === "artifacts.changed" && message.artifact.id === first.id && message.artifact.living?.since === since);
		now++;
		expect(await client.request({ ...update, living: true })).toMatchObject({ artifact: { living: { since }, tags: ["web"] } });
		const unmarked = await client.request({ ...update, living: false });
		if (unmarked.type !== "artifacts.update") throw errorOf(unmarked);
		expect(unmarked.artifact.living).toBeUndefined();
		expect(unmarked.artifact.tags).toEqual(["web"]);
		const sameTime = await store.save({ ...input, projectId, taskId: null });
		const acrossProjects = await store.save({ ...input, taskId: null });
		const withTies = await client.request({ type: "artifacts.library", limit: 1 });
		if (withTies.type !== "artifacts.library") throw errorOf(withTies);
		expect(withTies.artifacts.map(row => row.id).sort()).toEqual([sameTime.id, acrossProjects.id].sort());
		expect(withTies.nextBefore).toBe(sameTime.createdAt);

	} finally {
		client.close();
		await setup.cleanup();
	}
});


test("closed catalogue projects read their task facts without opening an agent runtime", async () => {
	const setup = await createSetup({ terminals: false });
	const project = await setup.server.manager.store.add(setup.projectDir);
	const { runtime } = await setup.server.manager.open(project.id);
	const task = await runtime.board.saveTask({ task: {
		title: "Check the paper stock", status: "todo", description: "", acceptance: null, blockedBy: [], blockedReason: null, writeScopes: [],
	} }, "coordinator");
	const saved = await setup.server.manager.artifacts.save({ projectId: project.id, sourcePath: join(setup.projectDir, "README.md"),
		taskId: task.id, threadId: "main", workerId: null });
	const server = await setup.restart();
	const open = spyOn(server.manager, "open");
	const client = await TestClient.open(server);
	try {
		await client.hello();
		expect(await client.request({ type: "artifacts.library" })).toMatchObject({
			type: "artifacts.library", artifacts: [{ id: saved.id }], tasks: [{ id: task.id, title: task.title }],
		});
		expect(open).not.toHaveBeenCalled();
	} finally {
		open.mockRestore();
		client.close();
	}
});
