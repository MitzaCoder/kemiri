/** Standing rules shared by every worker, captured once in its durable instructions at creation. */
import type { MemoryFile, MemoryScope } from "@kemiri/protocol";
import { ServerError, errorMessage } from "./errors.ts";
import { splitSections, type MemoryStore } from "./memory.ts";

export const WORKER_BRIEF_FILE_ID = "worker-brief";
/** Both scopes together, including the delimiter, explanation and any cut note. */
export const WORKER_BRIEF_MAX_CHARS = 6_000;

const BRIEF_START = "<project-brief>\nFrom the coordinator's memory: facts and standing rules for every worker of this project. Your brief from the coordinator wins where they differ.";
const BRIEF_END = "\n</project-brief>";
const CUT_NOTE = `\n\n(brief cut at ${WORKER_BRIEF_MAX_CHARS} characters; the coordinator keeps the rest in memory)`;

/** Keep the intro and each markdown section whole, in global-then-project order. */
export function renderWorkerBrief(topics: readonly { scope: MemoryScope; topic: MemoryFile }[]): string {
	const sections: string[] = [];
	for (const { scope, topic } of topics) {
		if (topic.file.status !== "active") continue;
		const { intro, sections: topicSections } = splitSections(topic.body);
		const parts = [
			...(intro.length === 0 ? [] : [intro]),
			...topicSections.map(({ heading, text }) => `## ${heading}\n\n${text}`),
		];
		if (parts.length === 0) continue;
		// Keep a scope label with its first section, never stranded at the cut.
		parts[0] = `## ${scope === "global" ? "Global" : "Project"} worker brief\n\n${parts[0]}`;
		sections.push(...parts);
	}
	if (sections.length === 0) return "";
	const full = `${BRIEF_START}\n\n${sections.join("\n\n")}${BRIEF_END}`;
	if (full.length <= WORKER_BRIEF_MAX_CHARS) return full;
	let brief = BRIEF_START;
	for (const section of sections) {
		if (brief.length + 2 + section.length + CUT_NOTE.length + BRIEF_END.length > WORKER_BRIEF_MAX_CHARS) break;
		brief += `\n\n${section}`;
	}
	return `${brief}${CUT_NOTE}${BRIEF_END}`;
}

/** Missing topics are normal; unreadable memory must never prevent a worker from starting. */
export async function readWorkerBrief(memory: Pick<MemoryStore, "read">, projectId: string, log: (message: string) => void): Promise<string> {
	try {
		const topics: { scope: MemoryScope; topic: MemoryFile }[] = [];
		for (const scope of ["global", "project"] as const) {
			try {
				const topic = await memory.read(scope, scope === "project" ? projectId : undefined, WORKER_BRIEF_FILE_ID);
				topics.push({ scope, topic });
			} catch (error) {
				if (!(error instanceof ServerError && error.code === "unknown_memory")) throw error;
			}
		}
		return renderWorkerBrief(topics);
	} catch (error) {
		log(`worker brief: could not read memory; starting without it: ${errorMessage(error)}`);
		return "";
	}
}
