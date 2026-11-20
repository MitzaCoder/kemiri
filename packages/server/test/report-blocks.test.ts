import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LEGACY_HARNESS_FEATURES, type ReportBlocksInput, type ResultBlock } from "@kemiri/protocol";
import { Lexer, type Tokens } from "marked";
import { BoardTaskReportSchema } from "../../protocol/src/board.ts";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { coordinatorWriter, describeBoard, describeTaskInFull, emptyBoardState, saveTask, workerWriter, writeReport, writeReportIn } from "../src/board.ts";
import { officialAgentWorkerTools } from "../src/official-agents/mcp-worker-tools.ts";
import { diffReportSections, reportMarkdown } from "../src/report-blocks.ts";
import { noteTaskFact } from "../src/task-freshness.ts";
import { crowdedResults, crowdedResultsWarnings } from "./fixtures/report-block-warnings.ts";
import { createSetup } from "./support.ts";

const at = "2026-11-05T12:00:00.000Z";
const by = coordinatorWriter("main");
const taskInput = { title: "Rehearse bookings", description: "", acceptance: null, status: "in_progress" as const, blockedBy: [], blockedReason: null, writeScopes: [] };
const finding = { kind: "finding", title: "The limit held", text: "The desk sent overflow to the waiting list." } as const;
const outcome = { kind: "outcome", text: "The desk opened." } as const;
const legacy = "### Older rehearsal\n\n> Move the sign at closing.\n\n    Keep this indentation.";

function reducer() {
	const state = emptyBoardState();
	saveTask(state, { task: taskInput, author: "coordinator", now: at });
	const write = (input: Partial<Parameters<typeof writeReport>[1]>) => writeReport(state, { taskId: "T1", sections: {}, by, now: at, ...input });
	return { state, write };
}

async function integration<T>(run: (setup: Awaited<ReturnType<typeof createSetup>>) => Promise<T>) {
	const setup = await createSetup({ now: () => Date.parse(at), boardEditDebounceMs: 60_000 });
	try { return await run(setup); } finally { await setup.cleanup(); }
}

async function openFixture(setup: Awaited<ReturnType<typeof createSetup>>) {
	const project = await setup.server.manager.add(setup.projectDir);
	const { runtime } = await setup.server.manager.open(project.id);
	await runtime.board.saveTask({ task: taskInput }, "coordinator");
	await runtime.board.saveTask({ task: { ...taskInput, title: "Other rehearsal" } }, "coordinator");
	return { runtime, project };
}

test("writes, preserves and clears typed sections independently of legacy strings and task revision", () => {
	const { write } = reducer();
	const first = write({ sections: { next: "Prepare the next session." }, blocks: { summary: [outcome], results: [finding], notDone: [{ kind: "risk", title: "Morning shift", text: "The morning shift is not covered." }] } });
	expect(first.revision).toBe(1);
	expect(first.report).toMatchObject({ summary: outcome.text, results: `- **${finding.title}**: ${finding.text}`, next: "Prepare the next session.", blocks: { results: [finding], summary: [outcome] } });
	const changed = write({ sections: { results: "A legacy update." }, blocks: { summary: [], next: [{ kind: "nextAction", text: "The desk will open the next session." }] } });
	expect(changed.revision).toBe(first.revision);
	expect(changed.report.results).toBe("A legacy update.");
	expect(changed.report.summary).toBeUndefined();
	expect(changed.report.blocks).toEqual({ next: [{ kind: "nextAction", text: "The desk will open the next session." }], notDone: first.report.blocks!.notDone });
	expect(write({ blocks: { results: [], next: [], notDone: [] } }).report).toMatchObject({ next: "", results: "" });
	expect(write({ sections: { now: "Reading" } }).report.blocks).toBeUndefined();
});

test("rejects invalid shapes, forbidden markup, conflicting formats and transport limits without a partial write", () => {
	const { write, state } = reducer();
	const before = structuredClone(state);
	const invalid = [
		{ summary: [finding] }, { summary: [outcome, outcome, outcome] }, { results: [{ kind: "markdown", text: legacy }] },
		{ results: [{ kind: "outcome", text: "   " }] }, { results: [{ kind: "outcome", text: "line\nline" }] },
		{ results: [{ kind: "outcome", text: "<b>Tag</b>" }] }, { results: [{ kind: "outcome", text: "[link](javascript:example)" }] },
		{ results: [{ kind: "outcome", text: "[link](https://example.org/artifacts/demo/proof?token=temporary)" }] },
		{ results: [{ kind: "outcome", text: "é".repeat(17_000) }] }, { results: Array(65).fill(outcome) },
		{ results: [{ kind: "metric", label: "Slots", value: Infinity }] }, { results: [{ ...finding, hidden: true }] },
		{ results: [{ kind: "setup", title: "Site", facts: Array(9).fill({ label: "Desk", value: "Window" }) }] },
	];
	for (const blocks of invalid) expect(() => write({ blocks: blocks as ReportBlocksInput, sections: { next: "Do not save this." } })).toThrow();
	expect(() => write({ blocks: { results: [] }, sections: { results: "Do not save this." } })).toThrow("either Markdown or blocks");
	expect(() => write({ addResult: "Both formats", addResultBlocks: [outcome] })).toThrow("not both");
	for (const blocks of [[], Array(9).fill(outcome)]) expect(() => write({ addResultBlocks: blocks })).toThrow("1–8");
	expect(state).toEqual(before);
	write({ blocks: { results: Array(64).fill(outcome) } });
	expect(() => write({ addResultBlocks: [finding] })).toThrow("at most 64");
});

test("mirrors preserve exact commands, ordered steps and escaped facts for an old report reader", () => {
	const { write } = reducer();
	const copyText = "  example-cli print 'amber'  \n```sh\n\n    example-cli close\n";
	const saved = write({ blocks: { steps: [{ kind: "step", text: "Print the sign.", copyText, language: "sh" }, { kind: "step", text: "Post the sign." }], results: [{ kind: "setup", title: "Rehearsal [Morning]", facts: [{ label: "Queue *label*", value: "[intake](https://example.org)" }] }] } });
	expect(LEGACY_HARNESS_FEATURES).not.toContain("task-report-blocks");
	expect(Check(Type.Omit(BoardTaskReportSchema, ["blocks"]), JSON.parse(JSON.stringify(saved.report)))).toBe(true);
	const list = Lexer.lex(saved.report.steps!)[0] as Tokens.List;
	expect(list).toMatchObject({ type: "list", ordered: true, start: 1 });
	expect(list.items[0]!.tokens.find(token => token.type === "code")).toMatchObject({ text: copyText, lang: "sh" });
	expect(list.items[1]!.raw).toStartWith("2. Post the sign.");
	expect(saved.report.results).toContain("**Queue \\*label\\***: \\[intake\\]");
});

test("keeps legacy Markdown as an exact prefix and preserves mixed appends in order", () => {
	const { write } = reducer();
	write({ sections: { results: legacy } });
	const first = write({ addResultBlocks: [outcome, finding] });
	expect(first.report.results).toStartWith(`${legacy}\n\n`);
	expect(first.report.blocks!.results).toEqual([{ kind: "markdown", text: legacy }, outcome, finding]);
	const repeat = write({ addResultBlocks: [{ ...outcome, text: "  **The desk opened.**  " }, finding] });
	expect(repeat.report.blocks).toEqual(first.report.blocks);
	const complex = "- Walk the desk.\n  - Count the queue.";
	write({ addResult: "* The sign went up." });
	write({ addResult: "- The sign went up." });
	write({ addResult: complex });
	write({ addResult: complex });
	const last = write({ addResultBlocks: [{ kind: "cleanup", text: "The desk removed the rehearsal sign." }] });
	expect(last.report.blocks!.results).toEqual([{ kind: "markdown", text: legacy }, outcome, finding, { kind: "outcome", text: "The sign went up." }, { kind: "markdown", text: complex }, { kind: "cleanup", text: "The desk removed the rehearsal sign." }]);
});

test("equivalent conversion and visual changes leave coverage stale, but changed labels and facts clear it", () => {
	const { write, state } = reducer();
	const old = write({ sections: { results: `* ${finding.title}: ${finding.text}`, next: "Collect the slips." } });
	noteTaskFact(state, "T1", { actor: "harness", kind: "stale", sections: ["results", "next"], reason: "New rehearsal", at });
	const same = write({ blocks: { results: [{ ...finding, text: `**${finding.text}**` }], next: [{ kind: "nextAction", text: "Collect the slips." }] } });
	expect(same.report.freshness!.results).toMatchObject({ stale: true, version: old.report.freshness!.results.version });
	expect(same.report.freshness!.next.stale).toBe(true);
	expect(diffReportSections(old.report, same.report)).toEqual([{ section: "results", factsChanged: false, structureChanged: true }, { section: "next", factsChanged: false, structureChanged: true }]);
	const edited = write({ blocks: { results: [{ ...finding, title: "The second limit held" }] } });
	expect(edited.report.freshness!.results).toMatchObject({ stale: false, coveredEventSeq: same.eventSeq! });
	expect(edited.report.freshness!.next.stale).toBe(true);
});

test("proof scope is atomic, retries are durable, and history separates structure from facts", async () => integration(async setup => {
	const { runtime, project } = await openFixture(setup);
	const commit = <T>(change: Parameters<typeof runtime.harness.commit<T>>[0]) => runtime.harness.commit(change, BACKGROUND_CONTEXT);
	const store = setup.server.artifacts;
	const sourcePath = `${setup.projectDir}/README.md`;
	const save = (projectId: string, taskId: string) => store.save({ projectId, taskId, sourcePath, title: null, note: null, threadId: "main", workerId: null });
	const proof = await save(project.id, "T1");
	await save(project.id, "T1");
	const wrongTask = await save(project.id, "T2");
	const wrongProject = await save("other-project", "T1");
	const proofBlock = (artifactId: string, version = 1) => ({ kind: "proof" as const, text: "The replay shows the switch to the waiting list.", artifactRef: { artifactId, version } });
	const write = (input: Partial<Parameters<typeof writeReportIn>[2]>, key: string) => commit(tx => writeReportIn(tx, runtime.conversation.id, { taskId: "T1", sections: {}, by, ...input }, key, at, { store, projectId: project.id }));
	await write({ sections: { results: `- ${outcome.text}` }, milestone: "Old report" }, "old");
	await write({ blocks: { results: [outcome] }, milestone: "Typed report" }, "typed");
	const before = (await runtime.board.state()).tasks[0];
	for (const block of [proofBlock(wrongTask.id), proofBlock(wrongProject.id), proofBlock(proof.id, 999)]) {
		await expect(write({ blocks: { results: [block] }, sections: { next: "Do not save this." }, milestone: "Must not save" }, "invalid")).rejects.toThrow("on this task in this project");
	}
	expect((await runtime.board.state()).tasks[0]).toEqual(before!);
	const append = { addResultBlocks: [proofBlock(proof.id)], by: workerWriter("main", "fixture"), milestone: "Replay cited" };
	await write(append, "worker-call");
	const intervening = await write({ addResultBlocks: [finding], by: append.by }, "next-call");
	const retried = await write(append, "worker-call");
	expect(retried.report).toEqual(intervening.report);
	expect(retried.eventSeq).toBe(intervening.eventSeq);
	const history = await runtime.board.history("T1");
	expect(history.at(-1)!.report.blocks!.results!.at(-1)).toEqual(proofBlock(proof.id));
	expect(history.map(snapshot => snapshot.label)).toEqual(["Old report", "Typed report", "Replay cited"]);
	const board = await runtime.board.get(true);
	const shown = describeTaskInFull(board.tasks[0]!, board, history);
	for (const text of [finding.title, finding.text, `${proof.id}~1`, "results blocks changed (same facts)"]) expect(shown).toContain(text);
	expect(shown).not.toContain("?token=");
	expect(describeBoard(board)).not.toContain(finding.text);
}), 15_000);

test("the official bridge shares the writer, honors scope and refuses stale runs", async () => integration(async setup => {
	const { runtime, project } = await openFixture(setup);
	let current = true;
	const bridge = await officialAgentWorkerTools({ projectId: project.id, workerId: "fixture", threadId: "main", taskId: "T1", taskLive: true, cwd: setup.projectDir, managedWorkspace: false, harness: runtime.harness, mainId: runtime.conversation.id, artifacts: setup.server.artifacts, isCurrent: async () => current });
	const call = (args: unknown, key: string) => bridge.call("task_progress", args, key, new AbortController().signal);
	const addResultBlocks: ResultBlock[] = crowdedResults;
	expect(await call({ taskId: "T2", addResultBlocks }, "spoof")).toMatchObject({ isError: true });
	expect(await call({ addResultBlocks, addResult: "Mixed formats." }, "mixed")).toMatchObject({ isError: true });
	const reply = await call({ addResultBlocks }, "bridge-write");
	expect(reply).not.toHaveProperty("isError");
	expect(reply.content).toEqual([{ type: "text", text: `Updated the report of T1 (report r1).\n${crowdedResultsWarnings.join("\n")}` }]);
	current = false;
	expect(await call({ addResultBlocks: [{ kind: "outcome", text: "Inactive worker." }] }, "inactive")).toMatchObject({ isError: true });
	const task = (await runtime.board.get(true)).tasks[0]!;
	expect(task.report.blocks?.results).toEqual(addResultBlocks);
	expect(task.report.results).toBe(reportMarkdown("results", addResultBlocks));
	expect((await runtime.board.get(true)).tasks[1]!.report.results).toBe("");
}), 15_000);
