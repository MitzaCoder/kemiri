import { diffWordsWithSpace } from 'diff';
import type { DiffRow, WordRange } from './diff-rows.js';

/** Pair consecutive delete/add rows, keeping offsets local to each row's UTF-16 text. */
export function diffWordRanges(rows: readonly DiffRow[]): WordRange[][] {
	const marks = rows.map(() => [] as WordRange[]);
	if (rows.length > 500) return marks;
	for (let index = 0; index < rows.length;) {
		if (rows[index]?.kind !== 'del') { index++; continue; }
		const start = index;
		while (rows[index]?.kind === 'del') index++;
		const added = index;
		while (rows[index]?.kind === 'add') index++;
		for (let pair = 0; pair < Math.min(added - start, index - added); pair++) {
			const oldIndex = start + pair, newIndex = added + pair;
			const before = rows[oldIndex]!.text, after = rows[newIndex]!.text;
			if (before.length + after.length > 4_096) continue;
			const parts = diffWordsWithSpace(before, after, { maxEditLength: 150, timeout: 8 });
			let oldOffset = 0, newOffset = 0;
			for (const part of parts ?? []) {
				const size = part.value.length;
				if (part.removed) marks[oldIndex]!.push({ from: oldOffset, to: oldOffset + size });
				if (part.added) marks[newIndex]!.push({ from: newOffset, to: newOffset + size });
				if (!part.added) oldOffset += size;
				if (!part.removed) newOffset += size;
			}
		}
	}
	return marks;
}
