/** The worker prompt rule against chained `cat`/`grep` false failures (`workers.ts`'s `workerInstructions`). */
import { describe, expect, it } from "bun:test";
import type { Project } from "../src/projects.ts";
import { coordinatorSection, threadCoordinatorSection, workerInstructions } from "../src/workers.ts";

function project(): Project {
	return {
		version: 1,
		id: "proj",
		name: "Demo",
		path: "/repo",
		createdAt: new Date(0).toISOString(),
		coordinator: { model: null, thinkingLevel: null },
		workerModels: [],
		checkIns: { enabled: true, intervalMinutes: 10 },
		longPromptCache: "coordinators",
		keepPromptCacheWarm: true,
		promptCacheWarmHours: 8,
		uiProof: "screenshots-and-videos",
		links: null,
	};
}

describe("workerInstructions", () => {
	it("tells both coordinators how to handle version-pinned artifact reviews", () => {
		for (const text of [coordinatorSection(project()), threadCoordinatorSection(project())]) {
			expect(text).toContain('Comments on "…" with an (artifact <id>~<n>, <file>) line');
			expect(text).toContain("Clarify: answer in chat");
			expect(text).toContain("Change / Show differently / Cut: artifact_read that version");
			expect(text).toContain("artifact_save with the same file name and taskId");
			expect(text).toContain("Keep: leave that part unchanged");
			expect(text).toContain('mark it handling when you act and addressed when done, naming the new version or "answered in chat"');
		}
	});

	it("tells main and background threads that planned pieces get parent only", () => {
		for (const text of [coordinatorSection(project()), threadCoordinatorSection(project())]) {
			expect(text).toContain("required part");
   expect(text).toContain("parts are done, in review or waiting");
   expect(text).toContain("blockedReason");
			expect(text).toContain("unplanned task discovered while working on another");
		}
	});

	it("steers amendments, queues only next tasks, and tells both coordinators to stay silent on repeats", () => {
		for (const text of [coordinatorSection(project()), threadCoordinatorSection(project())]) {
			expect(text).toContain("To add to a running worker's current task, use worker_send with interrupt: true so it lands in the same run and report.");
			expect(text).toContain("Queue only a separate next task.");
			expect(text).toContain("When a report repeats one already handled or adds nothing new, end the turn without a chat reply; do not acknowledge it, just as with uneventful check-ins.");
		}
		const text = workerInstructions({ id: "a", title: "t", project: project(), cwd: "/repo", isolation: "shared" });
		expect(text).toContain("If a queued message asks for something you already did and have reported, and you have no new result, warning or question, answer with exactly one line: Nothing new.");
		expect(text).toContain("Do not repeat the full report or do more checks. This line is recorded without waking the coordinator.");
	});

	it("explains stale report messages after introducing reports, for both coordinators", () => {
		for (const text of [coordinatorSection(project()), threadCoordinatorSection(project())]) {
			const report = text.indexOf("Each task has a short report");
			const stale = text.indexOf('A message starting with "[reports]" names task reports that went out of date.');
			expect(report).toBeGreaterThanOrEqual(0);
			expect(stale).toBeGreaterThan(report);
			expect(stale).toBeLessThan(text.indexOf("Only the user closes a task."));
			expect(text).toContain("rewrite only the stale Results or Next, with evidence");
			expect(text).toContain("pass the eventSeq show_task gave you as coveredEventSeq, so anything that happened since stays marked");
		}
	});

	it("tells a worker to use read instead of cat chains, and how grep/rg exit", () => {
		const text = workerInstructions({
			id: "fixer",
			title: "fix the bug",
			project: project(),
			cwd: "/repo",
			isolation: "shared",
		});
		expect(text).toContain("Read files with the read tool");
		expect(text).toContain("resolve it against that file's own folder");
		expect(text).toContain("exit 1 when nothing matches and 2 when a path is missing");
		expect(text).toContain("never add `|| true`");
	});

	it("gives only isolated workers generic workspace facts, with the resolved starting revision", () => {
		const base = { id: "a", title: "t", project: project(), cwd: "/worker", workspaceRevision: "0123456789abcdef" } as const;
		const facts = "This started as a fresh jj workspace created from 0123456789abcdef. Files the VCS ignores (for example installed dependencies, build outputs, local config) are not copied into it; set up what the project needs before building or testing. The harness keeps the workspace current when commits beneath it are rewritten, and reports updates or failures.";
		for (const threadId of ["main", "background"]) {
			const isolated = workerInstructions({ ...base, threadId, isolation: "workspace" });
			expect(isolated).toContain(facts);
			expect(isolated).not.toContain("bun install");
			expect(isolated).not.toContain("lockfile");
			const shared = workerInstructions({ ...base, threadId, isolation: "shared" });
			expect(shared).not.toContain("fresh jj workspace");
			expect(shared).not.toContain("Files the VCS ignores");
			expect(shared).not.toContain("keeps the workspace current");
		}
	});

	it("is the same text for a shared worker and one in its own workspace", () => {
		const base = { id: "a", title: "t", project: project(), cwd: "/repo" } as const;
		const shared = workerInstructions({ ...base, isolation: "shared" });
		const workspace = workerInstructions({ ...base, isolation: "workspace" });
		const rule = "Read files with the read tool, not a bash";
		expect(shared).toContain(rule);
		expect(workspace).toContain(rule);
	});
});
