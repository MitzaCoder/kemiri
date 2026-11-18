import { describe, expect, it } from "bun:test";
import { taskTextWarnings } from "../src/task-text-style.ts";

const prose = (text: string) => taskTextWarnings({ name: "Results", text });
const question = (text: string) => taskTextWarnings({ name: "Question", text, question: true });
const revisionWarning = "Leave commit hashes and change IDs out of prose.";

const thirtyWords = "This line has fifteen words in its first sentence, counting each written word here once. This sentence adds fifteen more words so the line can sit at exactly the limit.";
const fortyWords = `${thirtyWords} Ten more words make this single line too long now.`;

describe("task text warnings", () => {
	it("counts words per Markdown line, not per sentence or field", () => {
		expect(prose(`- ${thirtyWords}\n2. ${thirtyWords}\n${thirtyWords}`)).toBe("");
		expect(prose(`- ${fortyWords}`)).toBe("\nResults, “This line has fifteen words…”: Split this line; it has over 30 words.");
	});

	it("looks for mixed hex hashes and ID-like jj tokens, not words or parts of identifiers", () => {
		for (const id of ["a1b2c3d", "FA3B759D", "a".repeat(39) + "1", "mxzwpqsm", "qvxzusouvrks", "pmmqtwklqkmnwvtmuvxszwusopkssylq"]) {
			expect(prose(`It landed in ${id}.`)).toContain(revisionWarning);
		}
		expect(prose("The change ID is stylnout.")).toContain(revisionWarning);
		expect(prose(`A1b2c3, deadbeef, 1234567, sunspots, nonstops, promptly and tumorous aren't revisions. Nor are ${"a".repeat(40)}1, var_a1b2c3d or éa1b2c3d.`)).toBe("");
	});

	it("skips URLs and code while still checking the prose around them", () => {
		expect(prose("See https://example.com/commit/a1b2c3d, <https://example.com/mzzpmqrm>, [changes](/commit/a1b2c3d), or `jj show mxzwpqsm`.")).toBe("");
		expect(prose("Run ``git show `a1b2c3d`\nmzzpmqrm`` first.")).toBe("");
		expect(prose(`> \`\`\`sh\n> ${fortyWords} a1b2c3d\n> \`\`\`\n- ~~~~sh\n  ${fortyWords} mzzpmqrm\n  ~~~\n  a1b2c3d\n  ~~~~\nDone.`)).toBe("");
		expect(prose(`Run this command:\n\n    ${fortyWords} a1b2c3d\n    git show mxzwpqsm\n\nDone.`)).toBe("");
		expect(prose("Run `jj show mxzwpqsm`, or check a1b2c3d.")).toContain(revisionWarning);
	});

	it("checks the first sentence of a question and never demands a question from a warning", () => {
		expect(question("The patch is ready. Ship now?")).toContain("Put the question in the first sentence.");
		expect(question("Context without punctuation\n\nShip now?")).toContain("Put the question in the first sentence.");
		expect(question("Ship **v1.2** now?\nIt is ready to go.")).toBe("");
		expect(question("**Should we ship [the patch](https://example.com/a1b2c3d)?**")).toBe("");
		expect(taskTextWarnings({ name: "Warning", text: "The service is down." })).toBe("");
	});

	it("catches pairs of choice markers on one line or on separate lines", () => {
		for (const choices of ["(A) Ship now. (B) Wait.", "A) Ship now.\nB) Wait.", "1) Ship now.\n2) Wait."]) {
			expect(question(`When should we ship?\n${choices}`)).toContain("Put the choices in options, not in the question text.");
		}
		expect(question("Ship now? The grade was (A) on both checks (A) yesterday and today.")).toBe("");
		expect(question("Ship now? The help shows `(A) this (B) that`.\n~~~txt\n1) Ship now.\n2) Wait.\n~~~")).toBe("");
		expect(prose("1) Start the service.\n2) Check the logs.")).toBe("");
	});

	it("quotes the affected field and line and caps the tool reply across fields", () => {
		const warnings = taskTextWarnings(
			{ name: "Results", text: "Done." },
			{ name: "Next", text: "Inspect mzzpmqrm." },
			{ name: "Done when", text: `${fortyWords}\n${fortyWords}\nUse a1b2c3d.` },
		);
		expect(warnings.trim().split("\n")).toHaveLength(3);
		expect(warnings).toContain("Next, “Inspect mzzpmqrm.”:");
		expect(warnings).toContain("Done when, “This line has fifteen words…”:");
		expect(warnings).not.toContain("a1b2c3d");
	});
});
