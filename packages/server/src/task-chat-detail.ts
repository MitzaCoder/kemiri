/** Local Markdown heuristics for reusable detail. Never returns or stores the reply's text. */
const LONG_PROSE_CHARS = 800;
const WORD_COVERAGE = 0.8;
const NUMBERED_ITEM = /^( {0,3})\d{1,9}[.)][ \t]+(\S.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const INLINE_CODE = /(`+)([^`\n]+)\1(?!`)/g;

export type MissingChatDetail = { steps: number; command: boolean; code: boolean; prose: boolean };

function markdownParts(text: string) {
	const prose: string[] = [];
	const codeBlocks: string[] = [];
	let fence: string | undefined;
	let code: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const match = FENCE.exec(line);
		if (fence !== undefined) {
			if (match && match[1]![0] === fence[0] && match[1]!.length >= fence.length && !match[2]!.trim()) {
				codeBlocks.push(code.join("\n"));
				code = [];
				fence = undefined;
			} else code.push(line);
		} else if (match) {
			fence = match[1]!;
			// Keep indented fences from splitting the list they are part of.
			if (!/^\s/.test(line)) prose.push("");
		} else if (!/^\s*>/.test(line)) prose.push(line);
	}
	if (fence !== undefined) codeBlocks.push(code.join("\n")); // Markdown also allows a fence through EOF.
	return { lines: prose, codeBlocks };
}

function numberedLists(lines: readonly string[]): string[][] {
	const lists: string[][] = [];
	let items: string[] = [];
	let markerIndent = 0;
	const finish = () => { if (items.length >= 3) lists.push(items); items = []; };
	for (const line of lines) {
		const item = NUMBERED_ITEM.exec(line);
		if (item && (!items.length || item[1]!.length <= markerIndent)) {
			markerIndent = item[1]!.length;
			items.push(item[2]!);
		} else if (!line.trim()) {
			continue;
		} else if (items.length && /^\s+/.test(line)) {
			items[items.length - 1] += ` ${line.trim()}`;
		} else finish();
	}
	finish();
	return lists;
}

function whitespaceNormalized(text: string): string {
	return text.trim().replace(/\s+/g, " ");
}

function words(text: string): string[] {
	return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function covered(text: string, taskWords: ReadonlySet<string>): boolean {
	const tokens = [...new Set(words(text))];
	const significant = tokens.filter(word => word.length >= 3 || /\p{N}/u.test(word));
	const compared = significant.length ? significant : tokens;
	// Changed numeric values are substantive even in an otherwise nearly identical step.
	return compared.length === 0 || (compared.every(word => !/^\d+$/.test(word) || taskWords.has(word)) &&
		compared.filter(word => taskWords.has(word)).length / compared.length >= WORD_COVERAGE);
}

function commandLike(code: string): boolean {
	const text = code.trim();
	return /^(?:pwd|whoami|date|ls)$/.test(text) || /^\$\s+\S/.test(text) || /^\S+[^\n]*\s--?\w/.test(text) ||
		/^[\w]+(?:-[\w]+)+\s+\S/.test(text) ||
		/^(?:(?:sudo|env)\s+)*(?:npm|npx|pnpm|yarn|bun|git|jj|make|cmake|docker|podman|kubectl|helm|curl|wget|ssh|scp|rsync|cd|ls|pwd|cat|cp|mv|rm|mkdir|chmod|echo|find|grep|rg|sed|awk|python[\d.]*|bash|sh|fish|go|cargo|rustc|ruby|java|deno|dotnet|node|systemctl)\b\s+\S/.test(text) ||
		/^(?:\.\.?\/|\/~?)[^\s]+\s+\S/.test(text);
}

/** Task fields are separate so a code match cannot span two fields. `writtenChars` counts successful writes this turn. */
export function detectMissingChatDetail(reply: string, taskContent: readonly string[], writtenChars = 0): MissingChatDetail | undefined {
	const { lines, codeBlocks } = markdownParts(reply);
	const replyProse = lines.join("\n");
	const commands = [...replyProse.matchAll(INLINE_CODE)].map(match => match[2]!).filter(commandLike);
	const lists = numberedLists(lines);
	const prose = whitespaceNormalized(replyProse.replace(INLINE_CODE, " "));
	if (lists.length === 0 && codeBlocks.length === 0 && commands.length === 0 && prose.length < LONG_PROSE_CHARS) return undefined;

	const taskWords = new Set(taskContent.flatMap(words));
	const taskCode = new Set<string>();
	const taskCodeLines = new Set<string>();
	const taskProse = taskContent.map(field => {
		const parts = markdownParts(field);
		for (const block of parts.codeBlocks) {
			taskCode.add(whitespaceNormalized(block));
			for (const line of block.split("\n")) taskCodeLines.add(whitespaceNormalized(line));
		}
		return ` ${whitespaceNormalized(parts.lines.join("\n").replace(INLINE_CODE, (_, _ticks, code: string) => {
			taskCode.add(whitespaceNormalized(code));
			return " ";
		}))} `;
	});
	const missingCode = (code: string) => {
		const normalized = whitespaceNormalized(code);
		return normalized !== "" && !taskCode.has(normalized) && !taskProse.some(field => field.includes(` ${normalized} `));
	};
	const missing: MissingChatDetail = {
		steps: lists.reduce((total, items) => total + items.filter(item => !covered(item, taskWords)).length, 0),
		command: commands.some(command => !taskCodeLines.has(whitespaceNormalized(command)) && missingCode(command)),
		code: codeBlocks.some(missingCode),
		prose: prose.length >= LONG_PROSE_CHARS && writtenChars * 3 < prose.length && !covered(prose, taskWords),
	};
	return missing.steps || missing.command || missing.code || missing.prose ? missing : undefined;
}

export function missingChatDetailLabel(missing: MissingChatDetail): string {
	return [missing.steps === 1 ? "1 step" : missing.steps > 1 ? `${missing.steps} steps` : "",
		missing.command ? "a command" : "", missing.code ? "a code block" : "", missing.prose ? "long detail" : ""].filter(Boolean).join(", ");
}

export type ChatDetailCounts = Record<string, { flagged: number; clean: number }>;
const COUNT_DAYS = 30;

export function countChatDetailTurn(counts: ChatDetailCounts, at: number, flagged: boolean): string {
	const day = new Date(at).toISOString().slice(0, 10);
	const firstKeptDay = new Date(at - (COUNT_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
	for (const date of Object.keys(counts)) if (date < firstKeptDay || date > day) delete counts[date];
	const count = counts[day] ?? { flagged: 0, clean: 0 };
	counts[day] = { flagged: count.flagged + Number(flagged), clean: count.clean + Number(!flagged) };
	return day;
}
