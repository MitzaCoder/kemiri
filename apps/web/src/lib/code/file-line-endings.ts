import type { ChangeSet, Text } from '@codemirror/state';

/** CodeMirror represents all line breaks as one position. Carry the original separator for every untouched break. */
export function fileLineEndings(text: string) {
	const lines = text.split(/\r\n?|\n/g);
	const original = text.match(/\r\n?|\n/g) ?? [];
	const preferred = original[0] ?? '\n';
	const mixed = original.some(separator => separator !== preferred);
	let separators: string[] = original;
	return { lines, update(changes: ChangeSet, before: Text, after: Text): string {
		if (!mixed) return after.sliceString(0, after.length, preferred);
		if (after.lines === lines.length && after.toString() === lines.join('\n')) {
			separators = original;
			return text;
		}
		const next: string[] = [];
		let copied = 0;
		changes.iterChanges((from, to, _fromAfter, _toAfter, inserted) => {
			const start = before.lineAt(from).number - 1, end = before.lineAt(to).number - 1;
			for (; copied < start; copied++) next.push(separators[copied]!);
			for (let i = 0; i < inserted.lines - 1; i++) next.push(separators[start + i < end ? start + i : -1] ?? preferred);
			copied = end;
		});
		for (; copied < separators.length; copied++) next.push(separators[copied]!);
		separators = next;
		const parts: string[] = [];
		let line = 0;
		for (const value of after.iterLines()) { if (line) parts.push(next[line - 1]!); parts.push(value); line++; }
		return parts.join('');
	} };
}
