import { expect, test } from 'bun:test';
import { Text } from '@codemirror/state';
import fixtures from '../../../packages/protocol/test-vectors/code-review.json';
import { anchorCodeLines, codeReviewKey, formatCodeReview, MAX_CODE_COMMENTS, MAX_CODE_REVIEW_CHARS, readCodeReview, reanchorCodeLines, suggestedPatch, writeCodeReview, type CodeReview, type CodeReviewSource } from '../src/lib/code/code-review.js';

const vectors = fixtures as { source: CodeReviewSource; review: CodeReview; expected: string }[];
for (const vector of vectors) test(`code review renders ${vector.source.kind} fixture byte-for-byte`, () => {
	expect(formatCodeReview(vector.source, vector.review)).toBe(vector.expected);
});

test('anchors keep indentation, move unique quotes and reject missing or ambiguous quotes', () => {
	const anchor = anchorCodeLines(Text.of(['first', '  tea', '  bread', 'last']), 'menu.txt', 'after', 2, 3)!;
	expect(anchor.quotedText).toBe('  tea\n  bread');
	expect(reanchorCodeLines(Text.of(['new', 'first', '  tea', '  bread']), anchor)).toMatchObject({ startLine: 3, endLine: 4 });
	expect(reanchorCodeLines(Text.of(['new', 'first', '  jam', '  bread']), anchor)).toBeUndefined();
	const single = anchorCodeLines(Text.of(['first', '  tea', 'last']), 'menu.txt', 'after', 2, 2)!;
	expect(reanchorCodeLines(Text.of(['  tea', 'first', '  tea']), single)).toBeUndefined();
	expect(anchorCodeLines(Text.of(['x'.repeat(4001)]), 'menu.txt', 'file', 1, 1)).toBeUndefined();
});

test('replacement preserves indentation, handles deletions and cannot escape the fence', () => {
	const anchor = anchorCodeLines(Text.of(['first', '  tea']), 'menu\t.txt', 'file', 2, 2)!;
	expect(suggestedPatch(anchor, '')).toBe('--- "a/menu\\011.txt"\n+++ "b/menu\\011.txt"\n@@ -2,1 +1,0 @@\n-  tea');
	expect(suggestedPatch(anchor, '  tea')).toBeUndefined();
	const example = vectors[0]!;
	expect(formatCodeReview(example.source, { comments: [{ ...example.review.comments[0]!, replacement: '```' }], overall: '' })).toContain('````diff');
});

test('local review restores unfinished comments and bounds untrusted persisted data', () => {
	let raw: string | null = null;
	const storage = { getItem: () => raw, setItem: (_: string, text: string) => { raw = text; }, removeItem: () => { raw = null; } };
	const example = vectors[0]!, key = codeReviewKey('backend', 'project', example.source);
	const editor = { ...example.review.comments[0]!, id: 'unfinished' };
	expect(writeCodeReview(storage, key, { ...example.review, editor })).toBe(true);
	expect(readCodeReview(storage, key).editor).toEqual(editor);
	expect(writeCodeReview(storage, key, { comments: Array(MAX_CODE_COMMENTS + 1).fill(editor), overall: '' })).toBe(false);
	raw = 'x'.repeat(MAX_CODE_REVIEW_CHARS + 1);
	expect(readCodeReview(storage, key).comments).toEqual([]);
	writeCodeReview(storage, key, { comments: [], overall: '' });
	expect(raw).toBeNull();
});
