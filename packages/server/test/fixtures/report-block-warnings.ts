import type { ResultBlock } from "@kemiri/protocol";
import { wrappedReportParagraph } from "./report-paragraph.ts";

export const crowdedResults = [
	{ kind: "finding", title: "Morning rehearsal", text: wrappedReportParagraph.replaceAll("\n", " ") },
	{ kind: "finding", title: "Rehearsal conditions", text: "Site: Linden Hall; Session: Morning; Intake: Reservation desk." },
] satisfies ResultBlock[];

export const crowdedResultsWarnings = [
	"Results, “The morning team checked the…”: Split this 70-word block: Give each fact its own block: a finding, setup, proof or other Results block.",
	"Results, “Site: Linden Hall; Session: Morning;…”: Move conditions to a setup block and give other facts their own blocks.",
];
