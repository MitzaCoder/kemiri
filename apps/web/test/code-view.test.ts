import { describe, expect, test } from 'bun:test';
import type { Artifact } from '@kemiri/protocol';
import { Text } from '@codemirror/state';
import { codeLanguageForPath } from '../src/lib/code/languages.js';
import { loadCodeLanguage } from '../src/lib/code/language-extensions.js';
import { diffRows, diffSegments } from '../src/lib/code/diff-rows.js';
import { diffWordRanges } from '../src/lib/code/diff-words.js';
import { artifactComparisonPair, comparisonState } from '../src/lib/code/artifact-comparison.js';
import { sourceOffsets, sourceSelection } from '../src/lib/code/source-review.js';
import { codeTokenVariables, contrastAgainstWhite, darkenLatteToken } from '../src/lib/code/palette.js';
import { highlight, highlightRows } from '../src/lib/markdown/highlight.js';

describe('read-only code view', () => {
	test('resolves filenames, compound paths, case, and unsupported extensions', () => {
		for (const [path, language] of Object.entries({ 'src/App.TSX': 'tsx', 'C:\\docs\\index.HTM': 'html',
			'Dockerfile.preview': 'dockerfile', '.bashrc': 'shell', 'reports/check.log': 'text', 'constructor': 'text',
			'Page.svelte': 'svelte', 'flake.nix': 'nix', 'data.jsonl': 'json' })) {
			expect(codeLanguageForPath(path)).toBe(language);
		}
	});

	test('bundled Svelte and Nix parsers produce an extension', async () => {
		for (const language of ['svelte', 'nix']) expect(await loadCodeLanguage(language)).not.toEqual([]);
	});

	test('keeps numbered rows and gaps; tracks changed words across syntax boundaries', () => {
		const rows = diffRows('  19 context\n- 20 price = 10\n+ 20 price = 12\n ...\n+ 40   added', 'display');
		expect(rows.map(row => [row.kind, row.number, row.text])).toEqual([
			['ctx', '19', 'context'], ['del', '20', 'price = 10'], ['add', '20', 'price = 12'], ['gap', '', '⋯'], ['add', '40', '  added'],
		]);
		expect(diffRows('- 123 bottles\n+ 124 bottles', 'patch').map(row => row.text)).toEqual([' 123 bottles', ' 124 bottles']);
		const marks = diffWordRanges(rows);
		expect(marks).toEqual([[], [{ from: 8, to: 10 }], [{ from: 8, to: 10 }], [], []]);
		expect(diffSegments(rows[2]!.text, [{ content: 'price = 1' }, { content: '2', htmlStyle: { '--shiki-light': '#123456' } }], marks[2]!)
			.map(segment => [segment.text, segment.marked, segment.light])).toEqual([['price = ', false, undefined], ['1', true, undefined], ['2', true, '#123456']]);
	});

	test('keeps patch headers and numbers each side independently', () => {
		const rows = diffRows('--- a/a.txt\n+++ b/a.txt\n@@ -4,2 +10,3 @@\n same\n-old\n+new\n+more', 'patch');
		expect(rows.map(row => [row.kind, row.number])).toEqual([
			['meta', ''], ['meta', ''], ['meta', ''], ['ctx', '10'], ['del', '5'], ['add', '11'], ['add', '12'],
		]);
	});

	test('chooses adjacent retained snapshots and classifies comparable text', () => {
		const versions = [2, 5, 6].map(version => ({ id: `sample~${version}`, version, kind: 'text' }) as Artifact);
		expect(artifactComparisonPair(versions, 6)).toEqual({ before: versions[1], after: versions[2] });
		expect(artifactComparisonPair(versions, 2)).toEqual({ before: versions[0], after: versions[1] });
		expect(artifactComparisonPair(versions.slice(0, 1), 2)).toBeUndefined();
		const preview = (content: string, truncated = false) => ({ content, truncated });
		expect(comparisonState(preview('tea\r\n'), preview('tea\n'))).toBe('same');
		expect(comparisonState(preview('tea'), preview('bread'))).toBe('changes');
		expect(comparisonState(preview('tea'), preview('bread', true))).toBe('too-large');
		expect(comparisonState(preview('a'), preview('é'.repeat(524_289)))).toBe('too-large');
	});

	test('anchors selections in the full document and round-trips CRLF and UTF-16 offsets', () => {
		const prefix = 'unmounted line\r\n'.repeat(500) + '🥐 ';
		const doc = Text.of((prefix + 'bakery hours').split('\r\n'));
		const { originalOffset, normalizedOffset } = sourceOffsets(prefix + 'bakery hours');
		const from = normalizedOffset(prefix.length);
		const selection = sourceSelection(doc, from, from + 'bakery'.length, originalOffset);
		expect(selection?.anchor).toBe(`s:${prefix.length}`);
		expect(selection?.text).toBe('bakery');
		expect(originalOffset(from)).toBe(prefix.length);
		expect(sourceSelection(doc, from, from, originalOffset)).toBeUndefined();
	});

	test('all Latte syntax tokens reach 4.5:1 and Shiki loads both themes', async () => {
		for (const hex of Object.values(codeTokenVariables(false))) expect(contrastAgainstWhite(hex)).toBeGreaterThanOrEqual(4.5);
		expect(darkenLatteToken('#df8e1d')).not.toBe('#df8e1d');
		expect(await highlight('const price = 10', 'typescript')).toContain('--shiki-light:');
		const tokens = await highlightRows('const price = 10', 'typescript');
		expect(tokens[0]?.[0]?.htmlStyle?.['--shiki-dark']).toBeTruthy();
	});
});
