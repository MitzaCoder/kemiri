import { REPORT_BLOCK_SECTIONS, ReportBlocksInputSchema, ResultBlockSchema, type BoardTaskReport, type ReportBlock, type ReportBlocks, type ReportBlockSection, type ResultBlock } from "@kemiri/protocol";
import { Lexer, Marked, type Token, type Tokens } from "marked";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ArtifactStore } from "./artifacts.ts";
import { ServerError } from "./errors.ts";

export const ReportResultAppendSchema = Type.Array(ResultBlockSchema, { minItems: 1, maxItems: 8, description: "Append 1–8 ordered Results blocks (up to 32 KiB), one fact each. Title findings, put conditions in setup and caption proof with what it shows. Cite saved task artifacts by ID and optional retained version. Do not also send addResult." });
const MAX_BLOCK_BYTES = 32 * 1024;
const markdown = new Marked({ gfm: true });
const signedArtifactUrl = /(?:\/|%2f)artifacts(?:\/|%2f)[^\s]*?(?:\?|%3f)[^\s]*?\btoken(?:=|%3d)/i;
const html = /<!--|<![A-Z]|<\/?[a-z][a-z0-9-]*(?=[\s/>])/i;
const fail = (message: string): never => { throw new ServerError("bad_request", message); };

function safeProse(text: string): boolean {
	const blocks = markdown.lexer(text.trim());
	if (blocks.length !== 1 || blocks[0]?.type !== "paragraph") return false;
	let safe = true;
	markdown.walkTokens(blocks, token => {
		if (token.type === "html" || token.type === "image" || token.type === "del") safe = false;
		if (token.type === "link") {
			const href = (token as Tokens.Link).href;
			if (!/^(?:https?:\/\/|mailto:)/i.test(href) || signedArtifactUrl.test(href)) safe = false;
		}
	});
	return safe;
}

export function validateReportBlocks(blocks: unknown, append: unknown): void {
	if (blocks !== undefined && !Check(ReportBlocksInputSchema, blocks)) fail("Invalid report blocks or section/kind combination (up to 64 blocks per section, 2 in Summary and 8 facts in Setup).");
	if (append !== undefined && !Check(ReportResultAppendSchema, append)) fail("addResultBlocks needs 1–8 valid Results blocks.");
	const bytes = [blocks, append].reduce<number>((total, value) => total + (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value))), 0);
	if (bytes > MAX_BLOCK_BYTES) fail("A report write can submit at most 32 KiB of typed blocks.");
	const submitted: ReportBlock[] = [...Object.values((blocks ?? {}) as ReportBlocks).flat(), ...((append ?? []) as ResultBlock[])];
	for (const block of submitted) {
		if (signedArtifactUrl.test(JSON.stringify(block))) fail("Use a saved artifact reference, not a signed artifact URL.");
		if (("text" in block && !safeProse(block.text)) || (block.kind === "metric" && block.context !== undefined && !safeProse(block.context))) {
			fail("Report block prose accepts only short text with inline emphasis, code or safe links.");
		}
		const literals = block.kind === "setup" ? [block.title, ...block.facts.flatMap(fact => [fact.label, fact.value])] : block.kind === "metric" ? [block.label, block.unit] : "title" in block ? [block.title] : [];
		if (literals.some(text => text !== undefined && html.test(text))) fail("Report titles, labels and values must not contain raw HTML.");
		if (block.kind === "metric" && !Number.isFinite(block.value)) fail("A report metric must be finite.");
	}
}

export type ReportArtifactScope = { store: ArtifactStore; projectId: string };
export async function validateReportProofs(taskId: string, blocks: ReportBlocks | undefined, append: readonly ResultBlock[] | undefined, scope: ReportArtifactScope | undefined): Promise<void> {
	const references = [...(blocks?.results ?? []), ...(append ?? [])].flatMap(block => block.kind === "proof" ? [artifactReference(block)] : []);
	for (const ref of new Set(references)) {
		const artifact = await scope?.store.get(scope.projectId, ref);
		if (!artifact || artifact.taskId !== taskId) fail(`Proof ${ref} must name a retained artifact on this task in this project.`);
	}
}

function artifactReference({ artifactRef: { artifactId, version } }: Extract<ReportBlock, { kind: "proof" }>): string {
	return version === undefined ? artifactId : `${artifactId}~${version}`;
}

const literal = (text: string) => text.trim().replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "\\$&");
const bold = (text: string) => `**${literal(text)}**`;
function fenceFor(text: string): string {
	let length = 3;
	for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
	return "`".repeat(length);
}

export function reportMarkdown(section: ReportBlockSection, blocks: readonly ReportBlock[], includeReferences = true): string {
	const rows = blocks.map((block, index) => {
		switch (block.kind) {
			case "markdown": return block.text;
			case "outcome": return section === "results" ? `- ${block.text.trim()}` : block.text.trim();
			case "finding": case "risk": return `- ${bold(block.title)}: ${block.text.trim()}`;
			case "setup": return `${bold(block.title)}\n\n${block.facts.map(fact => `- ${bold(fact.label)}: ${literal(fact.value)}`).join("\n")}`;
			case "proof": return `- ${block.text.trim()}${includeReferences ? ` (Artifact: \`${artifactReference(block)}\`)` : ""}`;
			case "cleanup": return `- ${bold("Cleaned up")}: ${block.text.trim()}`;
			case "metric": return `- ${bold(block.label)}: ${block.value}${block.unit ? ` ${literal(block.unit)}` : ""}${block.context ? ` — ${block.context.trim()}` : ""}`;
			case "nextAction": return block.text.trim();
			case "step": {
				const marker = `${index + 1}. `;
				if (block.copyText === undefined) return marker + block.text.trim();
				const indent = " ".repeat(marker.length);
				const fence = fenceFor(block.copyText);
				return `${marker}${block.text.trim()}\n\n${indent}${fence}${block.language ?? ""}\n${block.copyText.split("\n").map(line => indent + line).join("\n")}\n${indent}${fence}`;
			}
		}
	});
	return rows.join(section === "notDone" ? "\n" : "\n\n");
}

/** Meter submitted prose and copyable steps, not generated headings, list markers or proof references. */
export function submittedBlockText(blocks: ReportBlocks | undefined): string[] {
	return REPORT_BLOCK_SECTIONS.flatMap(section => (blocks?.[section] ?? []).flatMap(block => {
		switch (block.kind) {
			case "markdown": return [];
			case "setup": return [];
			case "metric": return block.context === undefined ? [] : [block.context];
			case "step": return block.copyText === undefined ? [block.text] : [block.text, block.copyText];
			default: return [block.text];
		}
	}));
}

/** Only a single inline row can be adapted; never reinterpret nested or multiline legacy Markdown. */
export function legacyResultBlock(text: string): Extract<ReportBlock, { kind: "outcome" | "markdown" }> {
	const line = text.trim().replace(/^[-*] /, "").trim();
	const simple = !/^[ \t]*(?:\t| {4})/.test(text) && !/[\r\n]/.test(text.trim()) && !signedArtifactUrl.test(line) && safeProse(line);
	return simple ? { kind: "outcome", text: line } : { kind: "markdown", text };
}

export function reportAppendHasCapacity(blocks: ReportBlocks["results"]): void {
	if ((blocks?.length ?? 0) > 64) fail("Results can hold at most 64 blocks. Ask the coordinator to rewrite Results before appending more.");
}

/** Normalize object key order for structural comparison, independent of the tool transport. */
export function reportBlockStructure(blocks: readonly ReportBlock[] | undefined): string | undefined {
	return blocks === undefined ? undefined : JSON.stringify(blocks, (_field, value) => value && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

function inlineFacts(tokens: Token[]): string {
	return tokens.map(token => {
		const inline = token as Tokens.Generic;
		if (token.type === "link" || token.type === "image") return inline.tokens ? inlineFacts(inline.tokens) : inline.text;
		if (token.type === "codespan") return `\u0000${inline.text}\u0000`;
		if (inline.tokens) return inlineFacts(inline.tokens);
		return inline.text ?? inline.raw;
	}).join("");
}

const compactProse = (text: string) => text.split("\u0000").map((part, index) => index % 2 === 0 ? part.replace(/\s+/g, " ") : part).join("\u0000").trim();

function markdownFacts(text: string): string[] {
	function facts(tokens: Token[]): string[] {
		return tokens.flatMap(token => {
			const block = token as Tokens.Generic;
			switch (token.type) {
				case "space": case "hr": case "def": return [];
				case "list": return (token as Tokens.List).items.flatMap(item => facts(item.tokens));
				case "blockquote": return facts(block.tokens ?? []);
				case "code": return [`code:${block.text}`];
				case "paragraph": case "heading": case "text": {
					const tokens = block.tokens as Token[] | undefined;
					// A marked label can contain colons. Keep its boundary instead of flattening it into the body.
					const label = tokens?.[0];
					const rest = tokens && inlineFacts(tokens.slice(1));
					const readable = tokens ? inlineFacts(tokens) : block.text ?? block.raw;
					const unmarkedPair = /^([^:\n]+):\s+(\S.*)$/su.exec(readable);
					if (label?.type === "strong" && rest && /^:\s+\S/.test(rest)) {
						return [`pair:${JSON.stringify([compactProse(inlineFacts([label])), compactProse(rest.slice(1))])}`];
					}
					if (unmarkedPair) return [`pair:${JSON.stringify([compactProse(unmarkedPair[1]!), compactProse(unmarkedPair[2]!)])}`];
					const fact = compactProse(readable);
					return fact ? [`text:${fact}`] : [];
				}
				default: return [`markdown:${block.raw.trim()}`];
			}
		});
	}
	return facts(markdown.lexer(text));
}

/** Same readable facts for legacy text and typed sections; evidence IDs and visual decoration are not facts. */
export function reportSectionFacts(report: Pick<BoardTaskReport, ReportBlockSection | "blocks">, section: ReportBlockSection): string {
	const blocks = report.blocks?.[section];
	return JSON.stringify(blocks ? blocks.flatMap(block => {
		if (block.kind === "step") return [...markdownFacts(block.text), ...(block.copyText === undefined ? [] : [`code:${block.copyText}`])];
		return markdownFacts(reportMarkdown(section, [block], false));
	}) : markdownFacts(report[section] ?? ""));
}

export function sameAppendedBlocks(previous: readonly ReportBlock[] | undefined, append: readonly ResultBlock[]): boolean {
	if (!previous || previous.length < append.length) return false;
	// Normalize author padding and equivalent inline Markdown; keep block kinds and proof identity for append dedup.
	const normalize = (blocks: readonly ReportBlock[]) => blocks.map(block => [block.kind, markdownFacts(reportMarkdown("results", [block]))]);
	return JSON.stringify(normalize(previous.slice(-append.length))) === JSON.stringify(normalize(append));
}

export function legacyBullet(text: string): string {
	const line = text.trim();
	return /^[-*] /.test(line) ? line : `- ${line}`;
}

export function renderedReportText(text: string): string {
	return compactProse(inlineFacts(Lexer.lexInline(text))).replaceAll("\u0000", "");
}

/** Report history compares facts and structure separately. It never calls reformatting a new outcome. */
export function diffReportSections(before: Pick<BoardTaskReport, ReportBlockSection | "blocks">, after: Pick<BoardTaskReport, ReportBlockSection | "blocks">) {
	return REPORT_BLOCK_SECTIONS.flatMap(section => {
		const factsChanged = reportSectionFacts(before, section) !== reportSectionFacts(after, section);
		const structureChanged = reportBlockStructure(before.blocks?.[section]) !== reportBlockStructure(after.blocks?.[section]);
		return factsChanged || structureChanged ? [{ section, factsChanged, structureChanged }] : [];
	});
}
