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
			expect(text).toContain("Clarify: answer it; if it came as task feedback, put the answer in the feedback note.");
			expect(text).toContain("Change / Show differently / Cut: artifact_read that version");
			expect(text).toContain("artifact_save with artifactId");
			expect(text).toContain("answer plain questions in chat without a task");
			expect(text).toContain("follow-up with foundWhile pointing to the old task");
			expect(text).toContain("If the owner asks to reopen the old task or only answer, follow that.");
			expect(text).toContain("Keep: leave that part unchanged");
			expect(text).toContain("mark it handling when you act and addressed when done, naming the new version if you made one.");
		}
	});

	it("routes reusable detail onto the task first for both coordinators", () => {
		for (const text of [coordinatorSection(project()), threadCoordinatorSection(project())]) {
			expect(text).toContain("Would the owner need this again? Put it on the task first:");
			expect(text).toContain("Your steps is for manual actions: one numbered step block per action, starting with a verb. Keep exact values and commands in `copyText`.");
			expect(text).toContain("Clear Your steps when done; rewriting Next leaves it alone.");
			expect(text).toContain("Next is for one or two actions agents will take.");
			expect(text).toContain("A choice → `ask`. Ask the owner on the request. The first sentence is the question, and a choice can answer it.");
			expect(text).toContain("at most three short lines after the question; don't retell the task.");
			expect(text).toContain("Use `choices` with a short `label` and an `effect` saying what happens if picked. Set `recommended` on at most one choice and say why in a line.");
			expect(text).toContain("Prefer `blocks` for new reports.");
			expect(text).toContain("Plain sections still work for a short Next or a long numbered procedure.");
			expect(text).toContain("Summary takes one or two outcomes.");
			expect(text).toContain("Put each gap or leftover in Not done as a risk.");
			expect(text).not.toContain("Ship now: goes live tonight");
			expect(text).toContain("Results holds the findings in full, once. Title each finding and say what held or didn't.");
			expect(text).toContain("a table or a diagram → a file on the task");
			expect(text).toContain("the full answer in the feedback note. Short status answers stay in the note only; longer answers also update the report.");
			expect(text).toContain("Keep steps and answers complete.");
			expect(text).toContain("A chat reply is a line or two naming the task; it may repeat what is on the task. Never leave required facts only in chat or a file.");
			expect(text).not.toMatch(/answered in chat/i);
		}
	});

	it("shares the task prose and evidence rules with both coordinators and task workers", () => {
		const options = { id: "a", title: "t", project: project(), cwd: "/repo", isolation: "shared", taskId: "T1", taskLive: true } as const;
		const worker = workerInstructions(options);
		const official = workerInstructions({ ...options, officialAgent: true });
		for (const text of [coordinatorSection(project()), threadCoordinatorSection(project()), worker, official]) {
			expect(text.split("Write task text for a person.")).toHaveLength(2);
			expect(text).toContain("Start with what is different for the reader, not what you did.");
			expect(text).toContain("about 20 words per line, no semicolon chains.");
			expect(text).toContain("whole sentences with verbs and small words");
			expect(text).toContain("Give each fact its own block or prose line.");
			expect(text).toContain('Use names, not bare IDs.');
			expect(text).toContain("Say what is not done as plainly as what is.");
			expect(text).toContain("Don't repeat status, questions, decisions or files.");
			expect(text).toContain("no commit hashes, change IDs, check counts, file paths or worker names in prose.");
			expect(text).toContain("Use the `Kemiri-Task: T…` trailer, save files with `artifact_save`");
			expect(text).toContain("put checks in `checks` (name, result, count if known).");
			expect(text).not.toContain("evidence (commit, artifact, test run)");
		}
		for (const prompt of [worker, official]) {
			expect(prompt).toContain("Append finished Results with `addResultBlocks`, or `addResult` for one plain bullet.");
			expect(prompt).toContain("Use setup for conditions and proof to say what a saved file shows.");
			expect(prompt).toContain("`checks` updates checks by name");
		}
		expect(worker).toContain("`artifact_save` and `taskId`");
		expect(official).toContain("`artifact_save` (the task is assigned automatically)");
		expect(official).toContain("`task_progress` tool from the `kemiri` MCP server");
		expect(worker).toContain("Give the coordinator any questions, warnings, complete steps or full answers in your final report");
		expect(worker).toContain("Start substantial work with a plan of three to seven steps in `task_progress`.");
		expect(worker).toContain("Tick steps as they finish and rewrite the plan if the work changes.");
		expect(worker).toContain("Give commands a short `intent` when their purpose is not obvious.");
		for (const other of [coordinatorSection(project()), threadCoordinatorSection(project()), workerInstructions({ ...options, taskLive: false }), workerInstructions({ ...options, taskId: null })]) {
			expect(other).not.toContain("Start substantial work with a plan");
		}
		expect(worker).toBe(workerInstructions(options));
	});

	it("tells main and background threads where to put work needed for a request", () => {
		for (const text of [coordinatorSection(project()), threadCoordinatorSection(project())]) {
			expect(text).toContain("required part");
   expect(text).toContain("every part is done, dropped or waiting");
   expect(text).toContain("blockedReason");
			expect(text).toContain("even if unplanned");
			expect(text).toContain("If the owner sends a request back, fix it on that request, not as a new task.");
			expect(text).toContain("Never send a part to review.");
		}
	});

	it("steers amendments, queues only next tasks, and tells both coordinators to stay silent on repeats", () => {
		for (const text of [coordinatorSection(project()), threadCoordinatorSection(project())]) {
			expect(text).toContain("To add to a running worker's current task, use worker_send with interrupt: true so it lands in the same run and report.");
			expect(text).toContain("Queue only a separate next task.");
			expect(text).toContain("wait for it to finish and pass taskId with the new title");
			expect(text).toContain("When a report repeats one already handled or adds nothing new, end the turn without a chat reply; do not acknowledge it, just as with uneventful check-ins.");
		}
		const text = workerInstructions({ id: "a", title: "t", project: project(), cwd: "/repo", isolation: "shared" });
		expect(text).toContain("If a queued message asks for something you already did and have reported, and you have no new result, warning or question, answer with exactly one line: Nothing new.");
		expect(text).toContain("Do not repeat the full report or do more checks. This line is recorded without waking the coordinator.");
	});

	it("explains stale report messages after introducing reports, for both coordinators", () => {
		for (const text of [coordinatorSection(project()), threadCoordinatorSection(project())]) {
			const report = text.indexOf("Each task has a report the owner reads instead of the chat.");
			const stale = text.indexOf('A message starting with "[reports]" names stale sections or detail that is only in chat.');
			expect(report).toBeGreaterThanOrEqual(0);
			expect(stale).toBeGreaterThan(report);
			expect(text).toContain("Attach a `sectionViews` view only for a real table, diagram or visual comparison, after the conclusions are in blocks. Never put required facts only in the view.");
			expect(stale).toBeLessThan(text.indexOf("Only the owner closes a request, a task with no parent."));
			expect(text).toContain("Rewrite only stale sections; file missing detail using the routes above, not in another chat reply.");
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
