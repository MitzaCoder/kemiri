type TaskTextField = { name: string; text?: string | null; question?: boolean; paragraphs?: boolean };
type ProseLine = { text: string; quoteDepth: number; listContentIndent?: number; indent: number };

const LINE_WORD_LIMIT = 30;
const PARAGRAPH_WORD_LIMIT = 60;
const WARNING_LIMIT = 3;
const listMarker = /^\s*(?:[-+*]|\d+[.)])\s+/;
const skippedLine: ProseLine = { text: "", quoteDepth: 0, indent: 0 };

// Keep a line's prose for diagnostics. Fences can also be quoted or open inside a list.
function proseLines(text: string): ProseLine[] {
	let fence = "";
	let startsBlock = true;
	let insideList = false;
	let indentedCode = false;
	return text.split(/\r\n?|\n/).map(line => {
		const quotePrefix = /^(?:[ \t]*>[ \t]?)+/.exec(line)?.[0] ?? "";
		const unquoted = line.slice(quotePrefix.length);
		if (fence) {
			const closing = unquoted.trim();
			if (closing.startsWith(fence) && [...closing].every(character => character === fence[0])) {
				fence = "";
				startsBlock = true;
			}
			return skippedLine;
		}
		if (!unquoted.trim()) {
			startsBlock = true;
			return skippedLine;
		}
		if (/^(?: {4}| {0,3}\t)/.test(unquoted) && (indentedCode || (startsBlock && !insideList))) {
			indentedCode = true;
			return skippedLine;
		}
		indentedCode = false;
		startsBlock = false;
		const listContentIndent = listMarker.exec(unquoted)?.[0].length;
		if (listContentIndent !== undefined) insideList = true;
		else if (/^\S/.test(unquoted)) insideList = false;
		const opening = /^\s*(?:(?:[-+*]|\d+[.)])\s+)?(`{3,}[^`]*$|~{3,}.*$)/.exec(unquoted);
		if (opening) {
			fence = /^(`+|~+)/.exec(opening[1]!)![0];
			return skippedLine;
		}
		return {
			text: unquoted.replace(/^\s*(?:[-+*]|\d+\.)\s+/, "").trim(),
			quoteDepth: quotePrefix.match(/>/g)?.length ?? 0,
			...(listContentIndent === undefined ? {} : { listContentIndent }),
			indent: unquoted.length - unquoted.trimStart().length,
		};
	});
}

// An inline command or link still occupies a word's place, but its contents are not prose.
function maskNonProse(text: string): string {
	return text
		.replace(/(?<!`)(`+)(?!`)(?:(?!\n\s*\n)[\s\S])*?(?<!`)\1(?!`)/g, span => span.replace(/[^\n]+/g, "◊"))
		.replace(/\]\(<?[^\s)]+>?\)/g, "]")
		.replace(/(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.)[^\s<>]+/gi, url => `◊${url.match(/[.!?,;:)\]]+$/)?.[0] ?? ""}`);
}

const atxHeading = /^#{1,6}(?:\s|$)/;
const thematicBreak = /^(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const tablePipe = /(?<!\\)\|/;
const tableDelimiter = /^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?$/;

// Find passages before warning on lines, so a wrapped paragraph gets one split hint.
function longParagraphs(lines: ProseLine[], maskedLines: string[]): Map<number, { end: number; words: number }> {
	const paragraphs = new Map<number, { end: number; words: number }>();
	let start: number | undefined;
	let words = 0;
	const finish = (end: number, heading = false) => {
		if (!heading && start !== undefined && words > PARAGRAPH_WORD_LIMIT) paragraphs.set(start, { end, words });
		start = undefined;
		words = 0;
	};
	for (let line = 0; line < lines.length; line++) {
		const { quoteDepth, listContentIndent, indent } = lines[line]!;
		const prose = listContentIndent === undefined ? maskedLines[line]! : maskedLines[line]!.replace(/^\d+\)\s+/, "");
		// A quote can continue lazily without repeating the quote marker on every line.
		if (listContentIndent !== undefined || (start !== undefined && quoteDepth > lines[start]!.quoteDepth)) finish(line);
		if (start !== undefined && quoteDepth === lines[start]!.quoteDepth && /^(?:=+|-+)$/.test(prose) && indent >= (lines[start]!.listContentIndent ?? 0)) {
			finish(line, true); // Setext underline: the preceding passage was a heading.
			continue;
		}
		if (!prose || atxHeading.test(prose) || thematicBreak.test(prose)) {
			finish(line);
			continue;
		}
		const inSameBlock = (next: number) => lines[next]?.quoteDepth === quoteDepth && lines[next]?.listContentIndent === undefined;
		const delimiter = maskedLines[line + 1];
		if (delimiter && tablePipe.test(prose) && inSameBlock(line + 1) && tablePipe.test(delimiter) && tableDelimiter.test(delimiter)) {
			finish(line);
			line++;
			// A table row can omit the pipe when it only fills the first column.
			while (inSameBlock(line + 1)) {
				const row = maskedLines[line + 1]!;
				if (!row || atxHeading.test(row) || thematicBreak.test(row)) break;
				line++;
			}
			continue;
		}
		start ??= line;
		words += prose.replaceAll("◊", " ").match(/[\p{L}\p{N}][^\s]*/gu)?.length ?? 0;
	}
	finish(lines.length);
	return paragraphs;
}

function paragraphHint(name: string): string {
	switch (name) {
		case "Summary": return "Give the main outcome in one or two short sentences.";
		case "Not done": return "Put one gap on each line.";
		case "Next": return "Give one or two short actions.";
		case "Your steps": return "Use one numbered step per action and keep the exact values.";
		default: return "Lead with the outcome, then give each finding, setting and proof its own line.";
	}
}

function hasRevisionId(line: string): boolean {
	for (const { 0: token, index } of line.matchAll(/[\p{L}\p{N}_]+/gu)) {
		if (/^[a-f0-9]{7,40}$/i.test(token) && /[0-9]/.test(token) && /[a-f]/i.test(token)) return true;
		if (!/^[k-z]{8,32}$/.test(token)) continue;
		// A length/alphabet check alone hits words like “sunspots” and “tumorous”.
		const hasIdShape = /[qxz].*[qxz]|[klmnpqrstvwxz]{5}/.test(token) || (/[qxz]/.test(token) && /[klmnpqrstvwxz]{4}/.test(token));
		const followsIdLabel = /\b(?:change id|jj change)\b(?:\s+is)?[\s:#("'_*–-]*$/i.test(line.slice(0, index));
		if (hasIdShape || followsIdLabel) return true;
	}
	return false;
}

function firstSentenceIsQuestion(text: string): boolean {
	const firstParagraph = text.trimStart().split(/\n[ \t]*\n/, 1)[0] ?? "";
	// Ignore punctuation inside a version or similar dotted word, and allow closing Markdown or quotes.
	return /([.!?])(?=["'”’)*_\]~]*(?:\s|$))/.exec(firstParagraph)?.[1] === "?";
}

function choiceListLine(text: string): number | undefined {
	const firstMarkers = new Map<string, { label: string; line: number }>();
	for (const [line, prose] of text.split("\n").entries()) {
		for (const marker of prose.matchAll(/(?<![\w(])(?:\(([A-Z]|\d+)\)|([A-Z]|\d+)\))(?=\s)/g)) {
			const label = (marker[1] ?? marker[2])!;
			const style = `${marker[1] ? "parenthesized" : "suffix"}:${/\d/.test(label) ? "number" : "letter"}`;
			const first = firstMarkers.get(style);
			if (!first) firstMarkers.set(style, { label, line });
			else if (first.label !== label) return first.line;
		}
	}
	return undefined;
}

function lineOpening(line: string): string {
	const words = line.split(/\s+/);
	const opening = words.slice(0, 5).join(" ");
	return `“${opening.slice(0, 60)}${words.length > 5 || opening.length > 60 ? "…" : ""}”`;
}

/** Advisory text to append to a successful tool reply. Never edits the submitted text. */
export function taskTextWarnings(...fields: TaskTextField[]): string {
	const warnings: string[] = [];
	for (const field of fields) {
		if (!field.text?.trim()) continue;
		const prose = proseLines(field.text);
		const lines = prose.map(line => line.text);
		const masked = maskNonProse(lines.join("\n"));
		const maskedLines = masked.split("\n");
		const paragraphs = field.paragraphs ? longParagraphs(prose, maskedLines) : undefined;
		const warn = (text: string, fix: string) => warnings.push(`${field.name}, ${lineOpening(text)}: ${fix}`);
		if (field.question) {
			const firstLine = lines.findIndex(Boolean);
			if (firstLine >= 0 && !firstSentenceIsQuestion(masked)) warn(lines[firstLine]!, "Put the question in the first sentence.");
			const listLine = choiceListLine(masked);
			if (listLine !== undefined) warn(lines[listLine]!, "Put the choices in options, not in the question text.");
		}
		let warnedParagraphEnd = 0;
		for (const [line, prose] of maskedLines.entries()) {
			const paragraph = paragraphs?.get(line);
			if (paragraph) {
				warn(lines.slice(line, paragraph.end).join(" "), `Split this ${paragraph.words}-word paragraph: ${paragraphHint(field.name)}`);
				warnedParagraphEnd = paragraph.end;
			}
			if (line >= warnedParagraphEnd && (prose.match(/[\p{L}\p{N}◊][^\s]*/gu)?.length ?? 0) > LINE_WORD_LIMIT) warn(lines[line]!, "Split this line; it has over 30 words.");
			if (hasRevisionId(prose)) warn(lines[line]!, "Leave commit hashes and change IDs out of prose.");
			if (warnings.length >= WARNING_LIMIT) break;
		}
		if (warnings.length >= WARNING_LIMIT) break;
	}
	return warnings.slice(0, WARNING_LIMIT).map(warning => `\n${warning}`).join("");
}
