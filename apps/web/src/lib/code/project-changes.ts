import { ClientError } from '@kemiri/client';
import { MAX_CHANGE_PATH_BYTES, type ChangedFile, type ChangeSource, type ChangesFileResponse, type ChangesListResponse } from '@kemiri/protocol';
import { fitsCodeView } from './limits.js';

export type ChangeList = Omit<ChangesListResponse, 'type' | 'id'>;
export type ChangeFile = Omit<ChangesFileResponse, 'type' | 'id'>;
const CHANGE_PARAM = 'changes';
const fullHash = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;

export function changesFromUrl(url: { searchParams: { get(name: string): string | null } }): ChangeSource | undefined {
	const value = url.searchParams.get(CHANGE_PARAM) ?? '';
	if (/^T\d{1,16}$/.test(value)) return { kind: 'task', taskId: value };
	if (fullHash.test(value)) return { kind: 'commit', hash: value.toLowerCase() };
}

export function withChanges(url: Pick<URL, 'pathname' | 'search' | 'hash'>, source?: ChangeSource): string {
	const params = new URLSearchParams(url.search);
	if (!source) params.delete(CHANGE_PARAM);
	else params.set(CHANGE_PARAM, source.kind === 'task' ? source.taskId : source.hash);
	return url.pathname + (params.size ? `?${params}` : '') + url.hash;
}

export function changeCounts(files: readonly ChangedFile[]) {
	return files.reduce((counts, file) => ({ files: counts.files + 1, additions: counts.additions + file.additions,
		deletions: counts.deletions + file.deletions }), { files: 0, additions: 0, deletions: 0 });
}

export function groupChangedFiles(files: readonly ChangedFile[]) {
	const folders = new Map<string, { file: ChangedFile; index: number; name: string }[]>();
	files.forEach((file, index) => {
		const slash = file.path.lastIndexOf('/');
		const folder = slash < 0 ? '' : file.path.slice(0, slash);
		const entry = { file, index, name: file.path.slice(slash + 1) };
		const siblings = folders.get(folder);
		if (siblings) siblings.push(entry);
		else folders.set(folder, [entry]);
	});
	return Array.from(folders, ([folder, entries]) => ({ folder, entries }));
}

export function changeCommitPicker(list: ChangeList, requested: string | undefined) {
	const allowAll = list.contiguous === true && list.commits.length > 0;
	const commit = list.commits.find(row => row.hash === requested) ?? (!allowAll ? list.commits.at(-1) : undefined);
	return { allowAll, commit, reason: list.nonContiguousReason === 'not-first-parent-chain'
		? 'These task commits do not form one continuous range. Review them one at a time.' : undefined };
}

export function changeFileDisplay(file: ChangeFile) {
	if (file.binary) return { kind: 'binary' } as const;
	if (file.tooLarge) return { kind: 'patch', patch: file.patch, truncated: file.patchTruncated === true } as const;
	const before = file.before?.text ?? '', after = file.after?.text ?? '';
	if (!fitsCodeView(before) || !fitsCodeView(after)) return { kind: 'text', before, after } as const;
	return { kind: 'compare', before, after } as const;
}

export function changeReadProblem(error: unknown): string {
	if (error instanceof ClientError && error.code === 'not_found' && error.message === 'This project has no Git store')
		return 'This project has no Git repository to review.';
	return error instanceof Error ? error.message : 'Could not read these changes.';
}

const VIEWED_STORAGE = 'aiki.changes-viewed.v1';
export const MAX_VIEWED_CHANGES = 500;
const MAX_VIEWED_KEY_CHARS = MAX_CHANGE_PATH_BYTES + 512;
export const MAX_VIEWED_STORAGE_CHARS = 256 * 1024;
type ViewedStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Include the exact commit range so added task commits cannot inherit stale Viewed marks. */
export function viewedChangePrefix(backendId: string, projectId: string, source: ChangeSource, list: ChangeList): string {
	return JSON.stringify([backendId, projectId, source.kind, source.kind === 'task' ? source.taskId : source.hash,
		list.commits[0]?.hash, list.commits.at(-1)?.hash, list.commits.length]);
}

export function readViewedChanges(storage: ViewedStorage): Set<string> {
	try {
		const raw = storage.getItem(VIEWED_STORAGE);
		if (!raw || raw.length > MAX_VIEWED_STORAGE_CHARS) return new Set();
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) return new Set(parsed.filter((key): key is string => typeof key === 'string' &&
			key.length > 0 && key.length <= MAX_VIEWED_KEY_CHARS).slice(-MAX_VIEWED_CHANGES));
	} catch { /* Storage can be disabled or damaged. */ }
	return new Set();
}

export function setChangeViewed(storage: ViewedStorage, key: string, checked: boolean, inMemory = new Set<string>()): Set<string> {
	// Use the latest shared storage when possible; retain the in-memory state if storage is unavailable.
	let viewed: Set<string>;
	try { viewed = storage.getItem(VIEWED_STORAGE) === null ? new Set(inMemory) : readViewedChanges(storage); }
	catch { viewed = new Set(inMemory); }
	viewed.delete(key);
	if (checked && key.length <= MAX_VIEWED_KEY_CHARS) viewed.add(key);
	let retained = [...viewed].slice(-MAX_VIEWED_CHANGES);
	let payload = JSON.stringify(retained);
	while (payload.length > MAX_VIEWED_STORAGE_CHARS) {
		retained = retained.slice(1);
		payload = JSON.stringify(retained);
	}
	try { storage.setItem(VIEWED_STORAGE, payload); }
	catch { /* Keep the bounded set for the rest of this session. */ }
	return new Set(retained);
}
