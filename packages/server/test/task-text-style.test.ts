import { describe, expect, it } from "bun:test";
import { taskTextWarnings } from "../src/task-text-style.ts";
import { resultsParagraphWarning, wrappedReportParagraph } from "./fixtures/report-paragraph.ts";

const prose = (text: string) => taskTextWarnings({ name: "Results", text });
const report = (text: string, name = "Results") => taskTextWarnings({ name, text, paragraphs: true });
const question = (text: string) => taskTextWarnings({ name: "Question", text, question: true });
const revisionWarning = "Leave commit hashes and change IDs out of prose.";

const thirtyWords = "This line has fifteen words in its first sentence, counting each written word here once. This sentence adds fifteen more words so the line can sit at exactly the limit.";
const fortyWords = `${thirtyWords} Ten more words make this single line too long now.`;

describe("task text warnings", () => {
	it("counts words per Markdown line, not per sentence or field", () => {
		expect(prose(`- ${thirtyWords}\n2. ${thirtyWords}\n${thirtyWords}`)).toBe("");
		expect(prose(`- ${fortyWords}`)).toBe("\nResults, “This line has fifteen words…”: Split this line; it has over 30 words.");
	});

	it("warns once for the same 400 words on one line or softly wrapped", () => {
		const sentence = wrappedReportParagraph.split("\n")[0]!;
		const sentences = Array<string>(40).fill(sentence);
		const singleLine = sentences.join(" ");
		const wrapped = sentences.join("\n");
		const warning = `\n${resultsParagraphWarning.replace("70-word", "400-word")}`;
		expect(report(singleLine)).toBe(warning);
		expect(report(wrapped)).toBe(warning);
		expect(prose(wrapped)).toBe("");
		expect(report(`${fortyWords}\n${fortyWords}`)).toBe("\nResults, “This line has fifteen words…”: Split this 80-word paragraph: Lead with the outcome, then give each finding, setting and proof its own line.");
	});

	it("counts only prose and starts a new passage at a blank line", () => {
		const lines = wrappedReportParagraph.split("\n");
		const sixtyWords = lines.slice(0, 6).join("\n");
		const exactCopy = `\`\`${lines[6]}\n${lines[6]}\`\``;
		const withCopy = `${sixtyWords}\n${exactCopy} https://example.com/bookings`;
		expect(report(withCopy)).toBe("");
		expect(report(`${withCopy} Done.`)).toContain("Split this 61-word paragraph");
		expect(report(`${sixtyWords}\n\n${lines[6]}`)).toBe("");
	});

	it("counts each numbered step separately and joins a list item's continuation lines", () => {
		const lines = wrappedReportParagraph.split("\n");
		for (const marker of [".", ")"]) {
			expect(report(lines.map((line, i) => `${i + 1}${marker} ${line}`).join("\n"), "Your steps")).toBe("");
		}
		const list = `- Open the main door.\n- ${lines.join("\n  ")}\n- Close the waiting area.`;
		expect(report(list)).toBe(`\n${resultsParagraphWarning}`);
		expect(report(list, "Your steps")).toEndWith("Use one numbered step per action and keep the exact values.");
	});

	it("skips fenced and indented exact copy text, including a quoted fence", () => {
		const hundredWords = Array<string>(10).fill(wrappedReportParagraph.split("\n")[0]!).join("\n");
		expect(report(`\`\`\`text\n${hundredWords}\n\`\`\``)).toBe("");
		expect(report(hundredWords.replace(/^/gm, "    "))).toBe("");
		expect(report(`> ~~~text\n${hundredWords.replace(/^/gm, "> ")}\n> ~~~`)).toBe("");
		expect(report(wrappedReportParagraph.replace(/^/gm, "> "))).toBe(`\n${resultsParagraphWarning}`);
		expect(report(`> ${wrappedReportParagraph}`)).toBe(`\n${resultsParagraphWarning}`);
	});

	it("keeps tables and headings out of paragraph prose", () => {
		const lines = wrappedReportParagraph.split("\n");
		const table = ["Finding | Area", "--- | :---:", ...lines.map(line => `${line} | Doors`)].join("\n");
		expect(report(table)).toBe("");
		expect(report(table.replaceAll(" | Doors", ""))).toBe("");
		expect(report(`${table}\n\n${wrappedReportParagraph}`)).toBe(`\n${resultsParagraphWarning}`);
		expect(report(lines.map(line => `## ${line}`).join("\n"))).toBe("");
		expect(report(`${wrappedReportParagraph}\n===\n${lines[0]}`)).toBe("");
	});

	it("retains revision-ID warnings and tailors the split hint to the report section", () => {
		const warnings = report(`${wrappedReportParagraph}\nThe change ID is a1b2c3d.`, "Not done");
		expect(warnings.trim().split("\n")).toEqual([
			"Not done, “The morning team checked the…”: Split this 75-word paragraph: Put one gap on each line.",
			`Not done, “The change ID is a1b2c3d.”: ${revisionWarning}`,
		]);
		expect(report(wrappedReportParagraph, "Next")).toEndWith("Give one or two short actions.");
		expect(report(wrappedReportParagraph, "Summary")).toEndWith("Give the main outcome in one or two short sentences.");
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
