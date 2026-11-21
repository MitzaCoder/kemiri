import { describe, expect, test } from 'bun:test';
import { ClientError } from '@kemiri/client';
import type { ChangedFile } from '@kemiri/protocol';
import { changeCommitPicker, changeCounts, changeFileDisplay, changeReadProblem, changesFromUrl, groupChangedFiles,
	MAX_VIEWED_CHANGES, MAX_VIEWED_STORAGE_CHARS, readViewedChanges, setChangeViewed, viewedChangePrefix, withChanges, type ChangeList } from '../src/lib/code/project-changes.js';

const sha1 = 'a'.repeat(40), sha256 = 'b'.repeat(64);
const commit = (hash: string) => ({ hash, subject: 'Update recipe', author: 'Test Baker', time: '', landed: true });
const changed = (path: string, additions = 0, deletions = 0): ChangedFile => ({ path, status: 'modified', additions, deletions, binary: false });
const task = { kind: 'task', taskId: 'T12' } as const;

function memoryStorage() {
	const values = new Map<string, string>();
	return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

describe('project changes view model', () => {
	test('parses task IDs and full hashes, and preserves the underlying page when removing changes', () => {
		const page = new URL('https://bakery.example.test/project?task=T5&pane=chat#today');
		const withTaskChange = withChanges(page, task);
		expect(withTaskChange).toBe('/project?task=T5&pane=chat&changes=T12#today');
		expect(changesFromUrl(new URL(withTaskChange, page))).toEqual(task);
		for (const hash of [sha1, sha256]) expect(changesFromUrl(new URL(`?changes=${hash.toUpperCase()}`, page))).toEqual({ kind: 'commit', hash });
		for (const invalid of ['HEAD', 'abc123', '../T12', 't12', 'T', ` ${sha1}`]) expect(changesFromUrl(new URL(`?changes=${encodeURIComponent(invalid)}`, page))).toBeUndefined();
		expect(withChanges(new URL(withTaskChange, page))).toBe('/project?task=T5&pane=chat#today');
	});

	test('groups paths by destination folder, preserving file navigation order', () => {
		const files = [changed('README.md', 2, 1), changed('src/menu/item.ts', 4, 2), changed('src/menu/price.ts', 1, 3),
			{ ...changed('docs/guide.md'), status: 'renamed' as const, previousPath: 'guide.md' }];
		expect(groupChangedFiles(files).map(group => [group.folder, group.entries.map(row => [row.name, row.index])])).toEqual([
			['', [['README.md', 0]]], ['src/menu', [['item.ts', 1], ['price.ts', 2]]], ['docs', [['guide.md', 3]]],
		]);
		expect(changeCounts(files)).toEqual({ files: 4, additions: 7, deletions: 6 });
	});

	test('shows All commits only for a server-confirmed contiguous task', () => {
		const list: ChangeList = { commits: [commit(sha1), commit(sha256)], files: [], truncated: false, contiguous: true };
		expect(changeCommitPicker(list, undefined)).toMatchObject({ allowAll: true, commit: undefined });
		expect(changeCommitPicker(list, sha1).commit?.hash).toBe(sha1);
		const scattered = { ...list, contiguous: false, nonContiguousReason: 'not-first-parent-chain' as const };
		expect(changeCommitPicker(scattered, undefined)).toMatchObject({ allowAll: false, commit: { hash: sha256 }, reason: expect.stringContaining('one continuous range') });
		expect(changeCommitPicker(scattered, sha1).commit?.hash).toBe(sha1);
		expect(changeCommitPicker({ ...list, commits: [] }, undefined)).toMatchObject({ allowAll: false, commit: undefined });
	});

	test('uses distinct Viewed namespaces and bounds local persistence', () => {
		const list: ChangeList = { commits: [commit(sha1)], files: [], truncated: false };
		const prefix = viewedChangePrefix('bakery', 'menu', task, list);
		expect(viewedChangePrefix('shop', 'menu', task, list)).not.toBe(prefix);
		expect(viewedChangePrefix('bakery', 'menu', task, { ...list, commits: [commit(sha1), commit(sha256)] })).not.toBe(prefix);
		const storage = memoryStorage();
		for (let i = 0; i < MAX_VIEWED_CHANGES + 2; i++) setChangeViewed(storage, prefix + `src/file-${i}`, true);
		expect(readViewedChanges(storage).size).toBe(MAX_VIEWED_CHANGES);
		expect(readViewedChanges(storage).has(prefix + 'src/file-0')).toBe(false);
		const key = prefix + 'docs/pickup';
		setChangeViewed(storage, key, true);
		expect(readViewedChanges(storage).has(key)).toBe(true);
		setChangeViewed(storage, key, false);
		expect(readViewedChanges(storage).has(key)).toBe(false);
		for (let i = 0; i < 75; i++) setChangeViewed(storage, `${i}` + 'x'.repeat(4000), true);
		expect(Array.from(storage.values.values())[0]!.length).toBeLessThanOrEqual(MAX_VIEWED_STORAGE_CHARS);
	});

	test('distinguishes binary, clipped patches, missing sides, and repositories without Git', () => {
		expect(changeFileDisplay({ binary: true })).toEqual({ kind: 'binary' });
		expect(changeFileDisplay({ tooLarge: true, patch: '+Bread', patchTruncated: true })).toEqual({ kind: 'patch', patch: '+Bread', truncated: true });
		expect(changeFileDisplay({ after: { text: 'Bread', hash: sha1 } })).toEqual({ kind: 'compare', before: '', after: 'Bread' });
		expect(changeFileDisplay({ before: { text: '\n'.repeat(21_000), hash: sha1 } }).kind).toBe('text');
		expect(changeReadProblem(new ClientError('not_found', 'This project has no Git store'))).toContain('no Git repository');
		expect(changeReadProblem(new ClientError('not_found', 'No commit with that full hash in this project'))).toContain('No commit');
	});
});
