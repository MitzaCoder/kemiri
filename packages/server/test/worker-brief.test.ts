import { describe, expect, it } from "bun:test";
import type { MemoryFile, MemoryScope, MemoryStatus } from "@kemiri/protocol";
import { ServerError } from "../src/errors.ts";
import { readWorkerBrief, renderWorkerBrief, WORKER_BRIEF_FILE_ID, WORKER_BRIEF_MAX_CHARS } from "../src/worker-brief.ts";

function topic(scope: MemoryScope, body: string, status: MemoryStatus = "active"): { scope: MemoryScope; topic: MemoryFile } {
	return { scope, topic: { file: {
		scope, fileId: WORKER_BRIEF_FILE_ID, title: "Worker brief", summary: "Standing rules", tags: [], links: [],
		status, supersededBy: null, headings: [], created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z", source: null,
	}, body } };
}

describe("worker brief", () => {
	it("renders the intro and markdown sections, global before project", () => {
		const text = renderWorkerBrief([
			topic("global", "Use short reports.\n\n## Safety\n\nStop only processes you started."),
			topic("project", "A synthetic project.\n\n## Setup\n\nInstall dependencies in a fresh workspace."),
		]);
		expect(text).toBe(`<project-brief>
From the coordinator's memory: facts and standing rules for every worker of this project. Your brief from the coordinator wins where they differ.

## Global worker brief

Use short reports.

## Safety

Stop only processes you started.

## Project worker brief

A synthetic project.

## Setup

Install dependencies in a fresh workspace.
</project-brief>`);
	});

	it("omits missing, archived, superseded and empty topics", () => {
		expect(renderWorkerBrief([])).toBe("");
		expect(renderWorkerBrief([topic("global", "Old rule", "archived"), topic("project", "Older rule", "superseded")])).toBe("");
		expect(renderWorkerBrief([topic("project", "\n  \n")])).toBe("");
		expect(renderWorkerBrief([topic("global", "Old", "archived"), topic("project", "Project only")])).toContain("Project only");
	});

	it("caps both scopes together, keeping only a prefix of whole sections", () => {
		const text = renderWorkerBrief([
			topic("global", `## First\n\n${"a".repeat(2_500)}`),
			topic("project", `## Second\n\n${"b".repeat(2_500)}\n\n## Too large\n\n${"c".repeat(1_000)}\n\n## Later\n\nSmall but out of order.`),
		]);
		expect(text.length).toBeLessThanOrEqual(WORKER_BRIEF_MAX_CHARS);
		expect(text).toContain("a".repeat(2_500));
		expect(text).toContain("b".repeat(2_500));
		expect(text).not.toContain("Too large");
		expect(text).not.toContain("Later");
		expect(text).toContain(`(brief cut at ${WORKER_BRIEF_MAX_CHARS} characters; the coordinator keeps the rest in memory)`);
		expect(text).toEndWith("</project-brief>");
	});

	it("never slices an oversized intro or section, or mistakes fenced headings for sections", () => {
		for (const body of ["x".repeat(7_000), `## Long\n\n${"x".repeat(7_000)}`, `\`\`\`md\n## Not a section\n${"x".repeat(7_000)}\n\`\`\``]) {
			const text = renderWorkerBrief([topic("project", body)]);
			expect(text.length).toBeLessThanOrEqual(WORKER_BRIEF_MAX_CHARS);
			expect(text).toContain("brief cut at");
			expect(text).not.toContain("xxx");
			expect(text).not.toContain("## Long");
			expect(text).not.toContain("Not a section");
		}
	});

	it("does not cut a brief that fits the cap exactly", () => {
		const overhead = renderWorkerBrief([topic("project", "x")]).length - 1;
		const text = renderWorkerBrief([topic("project", "x".repeat(WORKER_BRIEF_MAX_CHARS - overhead))]);
		expect(text.length).toBe(WORKER_BRIEF_MAX_CHARS);
		expect(text).not.toContain("brief cut at");
	});

	it("reads only the two reserved topics, with the worker's project ID", async () => {
		const reads: unknown[][] = [];
		const text = await readWorkerBrief({ read: async (...args) => {
			reads.push(args);
			return topic(args[0], args[0] === "global" ? "Global rule" : "Project rule").topic;
		} }, "synthetic", () => { throw new Error("unexpected log"); });
		expect(reads).toEqual([["global", undefined, "worker-brief"], ["project", "synthetic", "worker-brief"]]);
		expect(text.indexOf("Global rule")).toBeLessThan(text.indexOf("Project rule"));
	});

	it("treats absent topics as normal and still reads the other scope", async () => {
		for (const missing of ["global", "project", "both"]) {
			const text = await readWorkerBrief({ read: async scope => {
				if (missing === scope || missing === "both") throw new ServerError("unknown_memory", "Missing");
				return topic(scope, "Standing rule").topic;
			} }, "synthetic", () => { throw new Error("unexpected log"); });
			expect(text.includes("<project-brief>")).toBe(missing !== "both");
		}
	});

	it("logs an unreadable scope and omits the entire block", async () => {
		for (const failing of ["global", "project"]) {
			const logs: string[] = [];
			const text = await readWorkerBrief({ read: async scope => {
				if (scope === failing) throw new Error("Synthetic read failure");
				return topic(scope, "Good rule").topic;
			} }, "synthetic", message => logs.push(message));
			expect(text).toBe("");
			expect(logs).toHaveLength(1);
			expect(logs[0]).toContain("starting without it: Synthetic read failure");
		}
	});
});
