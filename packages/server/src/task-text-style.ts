type TaskTextField = { name: string; text?: string | null; question?: boolean };

const LINE_WORD_LIMIT = 30;
const WARNING_LIMIT = 3;

// Keep a line's prose for diagnostics. Fences can also be quoted or open inside a list.
function proseLines(text: string): string[] {
	let fence = "";
	let startsBlock = true;
	let insideList = false;
	let indentedCode = false;
	return text.split(/\r\n?|\n/).map(line => {
		const unquoted = line.replace(/^(?:[ \t]*>[ \t]?)+/, "");
		if (fence) {
			const closing = unquoted.trim();
			if (closing.startsWith(fence) && [...closing].every(character => character === fence[0])) {
				fence = "";
				startsBlock = true;
			}
			return "";
		}
		if (!unquoted.trim()) {
			startsBlock = true;
			return "";
		}
		if (/^(?: {4}| {0,3}\t)/.test(unquoted) && (indentedCode || (startsBlock && !insideList))) {
			indentedCode = true;
			return "";
		}
		indentedCode = false;
		startsBlock = false;
		if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(unquoted)) insideList = true;
		else if (/^\S/.test(unquoted)) insideList = false;
		const opening = /^\s*(?:(?:[-+*]|\d+[.)])\s+)?(`{3,}[^`]*$|~{3,}.*$)/.exec(unquoted);
		if (opening) {
			fence = /^(`+|~+)/.exec(opening[1]!)![0];
			return "";
		}
		return unquoted.replace(/^\s*(?:[-+*]|\d+\.)\s+/, "").trim();
	});
}

// An inline command or link still occupies a word's place, but its contents are not prose.
function maskNonProse(text: string): string {
	return text
		.replace(/(?<!`)(`+)(?!`)(?:(?!\n\s*\n)[\s\S])*?(?<!`)\1(?!`)/g, span => span.replace(/[^\n]+/g, "◊"))
		.replace(/\]\(<?[^\s)]+>?\)/g, "]")
		.replace(/(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.)[^\s<>]+/gi, url => `◊${url.match(/[.!?,;:)\]]+$/)?.[0] ?? ""}`);
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
		const lines = proseLines(field.text);
		const masked = maskNonProse(lines.join("\n"));
		const warn = (line: number, fix: string) => warnings.push(`${field.name}, ${lineOpening(lines[line]!)}: ${fix}`);
		if (field.question) {
			const firstLine = lines.findIndex(Boolean);
			if (firstLine >= 0 && !firstSentenceIsQuestion(masked)) warn(firstLine, "Put the question in the first sentence.");
			const listLine = choiceListLine(masked);
			if (listLine !== undefined) warn(listLine, "Put the choices in options, not in the question text.");
		}
		for (const [line, prose] of masked.split("\n").entries()) {
			if ((prose.match(/[\p{L}\p{N}◊][^\s]*/gu)?.length ?? 0) > LINE_WORD_LIMIT) warn(line, "Split this line; it has over 30 words.");
			if (hasRevisionId(prose)) warn(line, "Leave commit hashes and change IDs out of prose.");
			if (warnings.length >= WARNING_LIMIT) break;
		}
		if (warnings.length >= WARNING_LIMIT) break;
	}
	return warnings.slice(0, WARNING_LIMIT).map(warning => `\n${warning}`).join("");
}
