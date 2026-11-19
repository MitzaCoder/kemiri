import { describe, expect, test } from "bun:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { buildWatcherEvidence, checkWatcherAnswer, watcherLineRateAllows, watcherPassReason, watcherPrompt,
	WATCHER_EVIDENCE_BYTES, WATCHER_MAX_STEPS, type WatcherAnswer, type WatcherEvidence, type WatcherPageLine } from "../src/task-watcher.ts";

function entry(id: number, role: string, content: unknown, attributes = {}): EntryRecord {
	return { id, conversationId: 1, kind: `pi.${role}`, model: [{ role, content, ...attributes }] } as unknown as EntryRecord;
}

describe("watcher evidence", () => {
	test("pairs results with their tool call and clips each untrusted field", () => {
		const entries = [
			entry(1, "user", "secret brief not part of the work evidence"),
			entry(2, "assistant", [{ type: "thinking", thinking: "Preparing the fixtures. ".repeat(30) },
				{ type: "text", text: "Looking at the fixtures. ".repeat(30) },
				{ type: "toolCall", id: "call1", name: "bash", arguments: { command: `bun test ${"x".repeat(400)}` } },
				{ type: "toolCall", id: "call2", name: "read", arguments: { path: "fixtures/example.txt" } }]),
			entry(3, "toolResult", [{ type: "text", text: `${"x".repeat(400)} missing fixture` }], { toolCallId: "call1", toolName: "bash", isError: true }),
			entry(4, "toolResult", "example text", { toolCallId: "call2", toolName: "read" }),
		];
		const evidence = buildWatcherEvidence(entries, [{ kind: "phase", text: "Inspecting fixtures" }]);
		expect(evidence.steps.map(step => step.id)).toEqual(["2", "3", "4"]);
		const [assistant, failed, read] = evidence.steps;
		expect(assistant?.thinking).toHaveLength(160);
		expect(assistant?.assistantText).toHaveLength(160);
		expect(failed).toMatchObject({ tool: "bash", intent: `bun test ${"x".repeat(111)}`, error: true });
		expect(failed?.resultTail).toHaveLength(160);
		expect(failed?.resultTail?.endsWith("missing fixture")).toBe(true);
		expect(read).toMatchObject({ tool: "read", intent: "fixtures/example.txt", error: false });
		expect(evidence.pageLines).toEqual([{ kind: "phase", text: "Inspecting fixtures" }]);
	});

	test("caps bytes after JSON escaping and prefers recent steps and page lines", () => {
		const punctuation = '文"\\'.repeat(180);
		const steps = Array.from({ length: 40 }, (_, i) => entry(i + 1, "assistant", [
			{ type: "thinking", thinking: punctuation }, { type: "text", text: punctuation },
			{ type: "toolCall", id: `call${i}`, name: "bash", arguments: { command: punctuation } },
		]));
		const page = Array.from({ length: 30 }, (_, i): WatcherPageLine => ({ kind: "result", text: `${i}: ${punctuation}` }));
		const evidence = buildWatcherEvidence(steps, page);
		const prompt = watcherPrompt(evidence);
		expect(new TextEncoder().encode(prompt.user).length).toBeLessThanOrEqual(WATCHER_EVIDENCE_BYTES);
		expect(evidence.steps.length).toBeLessThanOrEqual(WATCHER_MAX_STEPS);
		expect(evidence.steps.at(-1)?.id).toBe("40");
		expect(evidence.omittedSteps + evidence.steps.length).toBe(40);
		expect(evidence.pageLines.length).toBeLessThanOrEqual(12);
		expect(evidence.pageLines.at(-1)?.text.startsWith("29:")).toBe(true);
		expect(JSON.parse(prompt.user)).toEqual(evidence);
		expect(prompt.system).toContain("untrusted work-log data");
	});

	test("omits write content, images, and recognizable secrets", () => {
		const evidence = buildWatcherEvidence([
			entry(1, "assistant", [{ type: "toolCall", id: "call", name: "write", arguments: { path: "example.txt", content: "not sent" } }]),
			entry(2, "toolResult", [{ type: "image", data: "not sent" }, { type: "text", text: "Authorization: Bearer EXAMPLE-SECRET-012345" }], { toolCallId: "call" }),
		], []);
		expect(evidence.steps[1]).toMatchObject({ intent: "example.txt", resultTail: "[redacted]" });
		expect(JSON.stringify(evidence)).not.toContain("not sent");
		expect(JSON.stringify(evidence)).not.toContain("EXAMPLE-SECRET");
	});
});

describe("watcher trigger", () => {
	const step = { kind: "step" as const, at: 150_000, lastPassAt: 90_000, pendingSteps: 7, activityMs: 89_999 };
	test("wakes for step count or active time, but not on idle or without new steps", () => {
		expect(watcherPassReason(step)).toBeUndefined();
		expect(watcherPassReason({ ...step, pendingSteps: 8 })).toBe("steps");
		expect(watcherPassReason({ ...step, activityMs: 90_000 })).toBe("activity");
		expect(watcherPassReason({ ...step, kind: "idle", pendingSteps: 40 })).toBeUndefined();
		expect(watcherPassReason({ ...step, pendingSteps: 0, activityMs: 200_000 })).toBeUndefined();
	});
	test("throttles passes per task except at run end, and only flushes pending steps", () => {
		expect(watcherPassReason({ ...step, at: 149_999, pendingSteps: 20 })).toBeUndefined();
		expect(watcherPassReason({ ...step, at: 149_999, kind: "end" })).toBe("end");
		expect(watcherPassReason({ ...step, kind: "end", pendingSteps: 0 })).toBeUndefined();
	});
	test("enforces an independent three-minute interval on published lines", () => {
		expect(watcherLineRateAllows(0, undefined)).toBe(true);
		expect(watcherLineRateAllows(179_999, 0)).toBe(false);
		expect(watcherLineRateAllows(180_000, 0)).toBe(true);
	});
});

describe("watcher answer", () => {
	const evidence: WatcherEvidence = { steps: [{ id: "1", tool: "write", resultTail: "write: all tests pass" }, { id: "2", tool: "read" }],
		pageLines: [{ kind: "auto", text: "Checking the invalid date fixture in the import screen." }], omittedSteps: 0 };
	const check = (line: string | null, ids: unknown[] = ["1"]) => checkWatcherAnswer(JSON.stringify({ line, evidence: ids }), evidence);
	const dropped = (reason: Extract<WatcherAnswer, { kind: "dropped" }>["reason"]) => ({ kind: "dropped" as const, reason });
	test("accepts one grounded activity or nothing", () => {
		expect(check("Checking how the importer treats blank dates.", ["2"])).toEqual({ kind: "line", line: "Checking how the importer treats blank dates.", evidence: ["2"] });
		expect(check(null, [])).toEqual({ kind: "nothing" });
	});
	test("rejects extra prose, fields, duplicate keys, wrong types and evidence that is missing, repeated or out of scope", () => {
		for (const text of ["nothing", '```json\n{"line":null,"evidence":[]}\n```', '{"line":null,"line":"hi","evidence":[]}', '{"line":null,"evidence":[],"action":"run"}', '{"line":null,"evidence":[1]}']) {
			expect(checkWatcherAnswer(text, evidence)).toEqual(dropped("malformed"));
		}
		for (const ids of [[], ["3"], ["1", "1"]]) expect(check("Checking date validation.", ids)).toEqual(dropped("evidence"));
		expect(check(null)).toEqual(dropped("evidence"));
	});
	test("drops outcome claims even when cited tool output says they happened", () => {
		for (const line of ["All tests pass.", "Checking the fixtures, and all tests pass.", "Verifying the tests are now passing.", "Updating the report after the file was saved.", "Checking the change after it was deployed.", "Reviewing the patch after it was committed and pushed."]) {
			expect(check(line)).toEqual(dropped("outcome"));
		}
	});
	test("drops long, multiline and near-duplicate lines", () => {
		expect(check(`Checking ${"one ".repeat(20)}case.`)).toEqual(dropped("length"));
		expect(check(`Checking ${"x".repeat(155)}.`)).toEqual(dropped("length"));
		expect(check("Checking dates.\nReviewing imports.")).toEqual(dropped("not-plain-text"));
		expect(check("Checking dates. Reviewing imports.")).toEqual(dropped("not-plain-text"));
		expect(check("CHECKING INVALID DATE FIXTURE IN THE IMPORT SCREEN!")).toEqual(dropped("duplicate"));
		expect(check("Checking the invalid date fixture on an import screen.")).toEqual(dropped("duplicate"));
	});
});
