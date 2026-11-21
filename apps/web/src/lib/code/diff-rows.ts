export type DiffRow = { kind: 'add' | 'del' | 'ctx' | 'gap' | 'meta'; number: string; text: string };
export type WordRange = { from: number; to: number };

/** Display diffs use pi's numbered rows; unified patches keep their headers and hunk coordinates. */
export function diffRows(source: string, format: 'display' | 'patch'): DiffRow[] {
	let oldLine = 0, newLine = 0;
	let oldRemaining = 0, newRemaining = 0;
	return source.split(/\r\n?|\n/).map(text => {
		const kind = text[0] === '+' ? 'add' : text[0] === '-' ? 'del' : 'ctx';
		if (format === 'display') {
			if (/^\s*\.\.\.\s*$/.test(text)) return { kind: 'gap', number: '', text: '⋯' };
			const match = /^[+\- ](\s*\d+)? (.*)$/.exec(text);
			return match ? { kind, number: match[1]?.trim() ?? '', text: match[2]! } : { kind, number: '', text };
		}
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
		if (hunk) {
			oldLine = Number(hunk[1]);
			oldRemaining = Number(hunk[2] ?? 1);
			newLine = Number(hunk[3]);
			newRemaining = Number(hunk[4] ?? 1);
			return { kind: 'meta', number: '', text };
		}
		if ((oldRemaining || newRemaining) && /^[+\- ]/.test(text)) {
			const number = String(kind === 'del' ? oldLine : newLine);
			if (kind !== 'add') { oldLine++; oldRemaining = Math.max(0, oldRemaining - 1); }
			if (kind !== 'del') { newLine++; newRemaining = Math.max(0, newRemaining - 1); }
			return { kind, number, text: text.slice(1) };
		}
		if (!/^([-+])\1\1 |^(?:diff |index |\\ |Binary )/.test(text) && /^[+\- ]/.test(text)) return { kind, number: '', text: text.slice(1) };
		return { kind: 'meta', number: '', text };
	});
}

export type DiffToken = { content: string; htmlStyle?: Record<string, string> };
export function diffSegments(text: string, tokens: readonly DiffToken[], marks: readonly WordRange[]) {
	const syntax = tokens.map(token => token.content).join('') === text ? tokens : [{ content: text } as DiffToken];
	const segments: { text: string; marked: boolean; light?: string; dark?: string }[] = [];
	let offset = 0, index = 0;
	for (const token of syntax) {
		const end = offset + token.content.length;
		while (offset < end) {
			while (marks[index] && marks[index]!.to <= offset) index++;
			const mark = marks[index];
			const marked = !!mark && mark.from <= offset;
			const boundary = Math.min(end, mark ? marked ? mark.to : mark.from : end);
			segments.push({ text: text.slice(offset, boundary), marked, light: token.htmlStyle?.['--shiki-light'], dark: token.htmlStyle?.['--shiki-dark'] });
			offset = boundary;
		}
	}
	return segments;
}
