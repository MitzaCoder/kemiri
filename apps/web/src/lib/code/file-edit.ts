import type { CodeRoot, FileWriteResult } from '@kemiri/protocol';
import { codeRootKey, fileFromUrl } from './file-location.js';
import type { ReadFile } from './files-view.js';
import { fitsCodeView } from './limits.js';

export const showFileWriteSetting = (features: readonly string[] | undefined) => features?.includes('project-files-write') === true;
export const fileWritesEnabled = (features: readonly string[] | undefined, setting: boolean | undefined) => showFileWriteSetting(features) && setting === true;
export function canEditFile(enabled: boolean, root: CodeRoot, file: ReadFile | undefined, revealed: boolean) {
	return enabled && root.kind === 'project' && !revealed && !!file?.hash && file.text !== undefined &&
		!file.binary && !file.tooLarge && !file.sensitive && fitsCodeView(file.text);
}

export type FileVersion = { text: string; hash: string };
export type FileEdit = { base: FileVersion; text: string } & (
	{ kind: 'clean' | 'dirty' | 'saving' | 'saved' } | { kind: 'conflict'; disk: FileVersion } | { kind: 'error'; message: string }
);
export const openFileEdit = (base: FileVersion): FileEdit => ({ kind: 'clean', base, text: base.text });
export function changeFileEdit(edit: FileEdit, text: string): FileEdit {
	if (edit.kind === 'saving' || edit.kind === 'conflict' || text === edit.text) return edit;
	return { kind: text === edit.base.text ? 'clean' : 'dirty', base: edit.base, text };
}
export function beginFileSave(edit: FileEdit, keepMine = false): FileEdit | undefined {
	if (keepMine ? edit.kind !== 'conflict' : edit.kind !== 'dirty' && edit.kind !== 'error') return;
	const base = edit.kind === 'conflict' ? edit.disk : edit.base;
	if (!fitsCodeView(edit.text)) return { kind: 'error', base, text: edit.text, message: 'The edit exceeds the editor limits (1 MiB or 20,000 lines), or contains a null character.' };
	return { kind: 'saving', base, text: edit.text };
}
export function finishFileSave(edit: FileEdit, reply: FileWriteResult): FileEdit {
	return reply.status === 'conflict' ? { ...edit, kind: 'conflict', disk: reply.current } :
		{ kind: 'saved', base: { hash: reply.hash, text: edit.text }, text: edit.text };
}
export const useDiskVersion = (edit: FileEdit): FileVersion | undefined => edit.kind === 'conflict' ? edit.disk : undefined;
export const hasUnfinishedFileEdit = (edit: FileEdit | undefined): boolean => !!edit &&
	(edit.kind === 'saving' || edit.kind === 'conflict' || edit.text !== edit.base.text);
export function guardFileNavigation(edit: FileEdit | undefined, from: URL, to: URL | undefined, willUnload: boolean): 'allow' | 'confirm' | 'unload' {
	if (!hasUnfinishedFileEdit(edit)) return 'allow';
	if (willUnload) return 'unload';
	const fromFile = fileFromUrl(from), toFile = to && fileFromUrl(to);
	return to?.pathname === from.pathname && fromFile && toFile && fromFile.path === toFile.path &&
		codeRootKey(fromFile.root) === codeRootKey(toFile.root) ? 'allow' : 'confirm';
}
export const directEditDraft = (path: string): string => `I edited ${path.replace(/[\r\n\u2028\u2029]/g, ' ')} directly`;
