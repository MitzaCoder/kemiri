import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LEGACY_HARNESS_FEATURES } from "@kemiri/protocol";
import { ARTIFACT_VERSION_LIMIT } from "../src/artifacts.ts";
import { coordinatorWriter, describeBoard, describeTaskInFull, workerWriter, writeReportIn, type ReportWrite } from "../src/board.ts";
import { officialAgentWorkerTools } from "../src/official-agents/mcp-worker-tools.ts";
import { describeReportSectionViews } from "../src/report-section-views.ts";
import { createSetup, TestClient } from "./support.ts";

const at = "2026-11-05T12:00:00.000Z";
const by = coordinatorWriter("main");
const finding = { kind: "finding", title: "The limit held", text: "The desk sent overflow to the waiting list." } as const;
const risk = { kind: "risk", title: "Evening shift", text: "The evening shift still needs a rehearsal." } as const;
const blocks = { results: [finding], notDone: [risk] };
const html = "<table><tr><td>Morning rehearsal comparison</td></tr></table>";

async function withFixture(run: (fixture: Awaited<ReturnType<typeof openFixture>>) => Promise<void>) {
	const setup = await createSetup({ now: () => Date.parse(at), boardEditDebounceMs: 60_000 });
	try { await run(await openFixture(setup)); } finally { await setup.cleanup(); }
}

async function openFixture(setup: Awaited<ReturnType<typeof createSetup>>) {
	const project = await setup.server.manager.add(setup.projectDir);
	const { runtime } = await setup.server.manager.open(project.id);
	const task = { title: "Rehearse bookings", description: "", acceptance: null, status: "in_progress" as const, blockedBy: [], blockedReason: null, writeScopes: [] };
	await runtime.board.saveTask({ task }, "coordinator");
	await runtime.board.saveTask({ task: { ...task, title: "Other rehearsal" } }, "coordinator");
	const store = setup.server.artifacts;
	const scope = { store, projectId: project.id };
	const save = async ({ name = "comparison.html", source = html, taskId = "T1", projectId = project.id } = {}) => {
		const sourcePath = `${setup.projectDir}/${name}`;
		await Bun.write(sourcePath, source);
		return store.save({ projectId, taskId, sourcePath, title: null, note: null, threadId: "main", workerId: null });
	};
	let serial = 0;
	const write = (input: Partial<Parameters<typeof writeReportIn>[2]>, key = `write-${++serial}`) => runtime.harness.commit(tx =>
		writeReportIn(tx, runtime.conversation.id, { taskId: "T1", sections: {}, by, ...input }, key, at, scope), BACKGROUND_CONTEXT);
	return { setup, project, runtime, scope, save, write };
}

const pointer = (artifact: { id: string; version?: number }, label = "Open comparison table") => ({ artifactId: artifact.id, version: artifact.version!, label });

test("attaches, replaces and detaches pinned views while keeping unchanged sections and files", () => withFixture(async ({ runtime, scope, save, write }) => {
	const first = pointer(await save());
	const second = pointer(await save(), "Open revised comparison");
	const before = await write({ blocks, milestone: "Rehearsal findings" });
	const attached = await write({ sectionViews: { results: { ...first, label: ` ${first.label} ` }, notDone: first }, milestone: "Views attached" });
	expect(attached.revision).toBe(before.revision);
	expect(attached.report.revision).toBe(before.report.revision + 1);
	expect(attached.report.sectionViews).toEqual({ results: first, notDone: first });
	const preserved = await write({ blocks: { results: [{ text: finding.text, title: finding.title, kind: "finding" }] }, sections: { next: "Plan the evening rehearsal." } });
	expect(preserved.report.sectionViews).toEqual(attached.report.sectionViews!);
	const replaced = await write({ blocks: { results: [{ ...finding, text: "The desk added a second queue." }] }, sectionViews: { results: second }, milestone: "Revised comparison" });
	expect(replaced.report.sectionViews).toEqual({ results: second, notDone: first });
	const detached = await write({ sectionViews: { notDone: null }, milestone: "Gap view detached" });
	expect(detached.report.sectionViews).toEqual({ results: second });
	expect(detached.report.blocks?.notDone).toEqual([risk]);
	const edited = await write({ sections: { results: replaced.report.results } });
	expect(edited.report.sectionViews).toBeUndefined(); // Same mirror, but typed content was replaced with Markdown.
	await write({ blocks, sectionViews: { results: first, notDone: first } });
	expect((await write({ blocks: { notDone: [] } })).report.sectionViews).toEqual({ results: first });
	expect(await scope.store.list(scope.projectId, { taskId: "T1" })).toHaveLength(1);
	const history = await runtime.board.history("T1");
	expect(history.map(snapshot => snapshot.report.sectionViews)).toEqual([undefined, { results: first, notDone: first }, { results: second, notDone: first }, { results: second }]);
	expect(JSON.stringify(history)).not.toContain(html);
	const board = await runtime.board.get(true);
	const shown = describeTaskInFull(board.tasks[0]!, board, history);
	for (const change of ["Results view attached", "Not done view attached", "Results view replaced", "Not done view detached"]) expect(shown).toContain(change);
	expect(describeBoard(board)).not.toContain(first.label);
}), 15_000);

test("rejects invalid section views before writing any sections or a snapshot", () => withFixture(async ({ runtime, save, write }) => {
	const valid = pointer(await save());
	const wrongTask = pointer(await save({ taskId: "T2" }));
	const wrongProject = pointer(await save({ projectId: "other-project" }));
	const wrongType = pointer(await save({ name: "comparison.txt" }));
	const oversized = pointer(await save({ name: "oversized.html", source: "é".repeat(128 * 1024) + "x" }));
	await write({ sections: { results: "The desk opened." } });
	await expect(write({ sectionViews: { results: valid } })).rejects.toThrow("meaningful typed blocks");
	const before = (await runtime.board.get(true)).tasks[0];
	const invalid: [unknown, string][] = [
		[{ summary: valid }, "only results and notDone"],
		[{ next: valid }, "only results and notDone"],
		[{ steps: valid }, "only results and notDone"],
		[{ results: { ...valid, label: " " } }, "short label"],
		[{ results: { ...valid, label: "a".repeat(81) } }, "short label"],
		[{ results: { ...valid, version: 1.5 } }, "exact version"],
		[{ results: { artifactId: valid.artifactId, label: valid.label } }, "exact version"],
		[{ results: { ...valid, version: 999 } }, "retained artifact"],
		[{ results: wrongTask }, "on this task in this project"],
		[{ results: wrongProject }, "on this task in this project"],
		[{ results: wrongType }, "HTML artifacts"],
		[{ results: oversized }, "256 KiB"],
	];
	for (const [sectionViews, reason] of invalid) {
		await expect(write({ blocks, sectionViews: sectionViews as ReportWrite["sectionViews"], sections: { next: "Do not save this." }, milestone: "Do not save this" })).rejects.toThrow(reason);
	}
	await expect(write({ blocks, sectionViews: { results: valid }, by: workerWriter("main", "fixture") })).rejects.toThrow("Only a coordinator");
	expect((await runtime.board.get(true)).tasks[0]).toEqual(before!);
	expect(await runtime.board.history("T1")).toEqual([]);
	const boundary = pointer(await save({ name: "boundary.html", source: "é".repeat(128 * 1024) }));
	expect((await write({ blocks, sectionViews: { results: boundary } })).report.sectionViews).toEqual({ results: boundary });
}), 15_000);

test("worker reads show the pinned view and both forms of real append detach it", () => withFixture(async ({ setup, project, runtime, save, write }) => {
	const view = pointer(await save());
	const bridge = await officialAgentWorkerTools({ projectId: project.id, workerId: "fixture", threadId: "main", taskId: "T1", taskLive: true, cwd: setup.projectDir, managedWorkspace: false, harness: runtime.harness, mainId: runtime.conversation.id, artifacts: setup.server.artifacts, isCurrent: async () => true });
	const call = (args: unknown, key: string) => bridge.call("task_progress", args, key, new AbortController().signal);
	await write({ blocks, sectionViews: { results: view, notDone: view } });
	const read = await call({}, "read");
	expect(read.content).toEqual([{ type: "text", text: expect.stringContaining(`Results view: "${view.label}" (${view.artifactId}~1)`) }]);
	expect(JSON.stringify(read)).not.toContain(html);
	expect(await call({ sectionViews: { results: null } }, "try-detach")).toMatchObject({ isError: true });
	const addResult = "The desk closed at noon.";
	const addResultBlocks = [{ kind: "outcome", text: "The desk reopened the next morning." }];
	for (const [index, append] of [{ addResult }, { addResultBlocks }].entries()) {
		expect(await call(append, `append-${index}`)).not.toHaveProperty("isError");
		expect((await runtime.board.get(true)).tasks[0]!.report.sectionViews).toEqual({ notDone: view });
		await write({ sectionViews: { results: view } });
		await call(append, `append-${index}`);
		await call(append, `adjacent-repeat-${index}`);
		expect((await runtime.board.get(true)).tasks[0]!.report.sectionViews).toEqual({ results: view, notDone: view });
	}
}), 15_000);

test("a pruned pin survives in the report and history and is never replaced with latest", () => withFixture(async ({ setup, project, runtime, scope, save, write }) => {
	const view = pointer(await save());
	await write({ blocks, sectionViews: { results: view }, milestone: "Comparison saved" });
	for (let n = 0; n < ARTIFACT_VERSION_LIMIT; n++) await save();
	const client = await TestClient.open(setup.server);
	try {
		const hello = await client.hello();
		expect(hello).toMatchObject({ type: "hello", features: expect.arrayContaining(["task-report-section-views"]) });
		expect(LEGACY_HARNESS_FEATURES).not.toContain("task-report-section-views");
		const url = { type: "artifacts.url", projectId: project.id } as const;
		expect(await client.request({ ...url, artifactId: view.artifactId })).toMatchObject({ type: "artifacts.url" });
		expect(await client.request({ ...url, artifactId: `${view.artifactId}~1` })).toMatchObject({ type: "error", error: { code: "unknown_artifact" } });
		const board = await write({ sections: { next: "Plan the evening rehearsal." } });
		expect(await describeReportSectionViews(board.id, board.report, scope)).toEqual([`Results view: "${view.label}" (${view.artifactId}~1) — View unavailable`]);
		expect(board.report.sectionViews).toEqual({ results: view });
		expect((await runtime.board.history("T1"))[0]!.report.sectionViews).toEqual({ results: view });
	} finally { client.close(); }
}), 15_000);
