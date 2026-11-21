import type { CodeRoot, FileListEntry, FilesListResponse, FilesReadResponse } from '@kemiri/protocol';
import { codeRootKey, PROJECT_ROOT } from './file-location.js';

export type FileListing = Omit<FilesListResponse, 'type' | 'id'>;
export type ReadFile = Omit<FilesReadResponse, 'type' | 'id'>;
export type RootChoice = { root: CodeRoot; label: string };
export function fileRootChoices(project: string, workers: readonly { id: string; title: string; workspacePath: string | null }[],
	threads: readonly { id: string; title: string; main: boolean; archived: boolean }[]): RootChoice[] {
	return [ { root: PROJECT_ROOT, label: project },
		...workers.filter(worker => worker.workspacePath).map(({ id, title }) => ({ root: { kind: 'worker' as const, workerId: id }, label: `Workspace · ${title || id}` })),
		...threads.filter(thread => !thread.main && !thread.archived).map(({ id, title }) => ({ root: { kind: 'thread' as const, threadId: id }, label: `Thread · ${title || id}` })) ];
}
export function folderKey(root: CodeRoot, path: string, hidden: boolean): string { return JSON.stringify([codeRootKey(root), path, hidden]); }
export type FileTreeRow = { path: string; parent: string; entry: FileListEntry; depth: number };
export function treeRows(directory: string, listing: (path: string) => FileListing | undefined, expanded: ReadonlySet<string>, depth = 1): FileTreeRow[] {
	return (listing(directory)?.entries ?? []).flatMap(entry => {
		const path = directory ? `${directory}/${entry.name}` : entry.name;
		return [{ path, parent: directory, entry, depth }, ...(entry.kind === 'dir' && expanded.has(path) ? treeRows(path, listing, expanded, depth + 1) : [])];
	});
}
export const parentFolder = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
export function fileReadState(file: ReadFile) {
	if (file.sensitive) return { kind: 'sensitive' } as const;
	if (file.binary) return { kind: 'binary', mimeType: file.mimeType ?? 'application/octet-stream' } as const;
	if (file.tooLarge) return { kind: 'too-large', size: file.size } as const;
	if (file.text !== undefined && file.hash) return { kind: 'text', text: file.text, hash: file.hash } as const;
	return { kind: 'unavailable' } as const;
}
export function searchCursor(index: number, delta: number, count: number): number {
	return !count ? -1 : index < 0 ? (delta < 0 ? count - 1 : 0) : (index + count + delta) % count;
}
