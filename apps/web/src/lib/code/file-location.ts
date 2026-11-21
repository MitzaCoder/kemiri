import type { CodeRoot } from '@kemiri/protocol';

export const PROJECT_ROOT: CodeRoot = { kind: 'project' };
export type FileLocation = { root: CodeRoot; path: string; line?: number };
export const codeRootKey = (root: CodeRoot): string => root.kind === 'project' ? 'project' : root.kind === 'worker' ? `worker:${root.workerId}` : `thread:${root.threadId}`;
export function parseCodeRoot(value: string | null): CodeRoot | undefined {
	if (!value || value === 'project') return PROJECT_ROOT;
	const match = /^(worker|thread):([\w-]{1,200})$/.exec(value);
	return !match ? undefined : match[1] === 'worker' ? { kind: 'worker', workerId: match[2]! } : { kind: 'thread', threadId: match[2]! };
}
export function fileLine(value: unknown): number | undefined {
	if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9]\d{0,8}$/.test(value))) return;
	const line = Number(value);
	return Number.isSafeInteger(line) && line > 0 && line <= 999_999_999 ? line : undefined;
}
export function validFilePath(path: string): boolean {
	return path.length > 0 && path.length <= 4096 && new TextEncoder().encode(path).length <= 4096 && !/^[a-z]:/i.test(path) && !/[\\\0]/.test(path) &&
		path.split('/').every(part => part && !/^(?:\.{1,2}|\.(?:git|jj))$/i.test(part));
}
export function pathInCheckout(path: string, checkout?: string): string | undefined {
	const prefix = checkout?.replace(/[/\\]+$/, '').replaceAll('\\', '/');
	const candidate = path.replaceAll('\\', '/');
	const relative = prefix && candidate.startsWith(`${prefix}/`) ? candidate.slice(prefix.length + 1) : candidate.replace(/^\.\//, '');
	return validFilePath(relative) ? relative : undefined;
}
export function fileFromUrl(url: { searchParams: Pick<URLSearchParams, 'get'> }): FileLocation | undefined {
	const path = url.searchParams.get('file');
	const root = parseCodeRoot(url.searchParams.get('root'));
	if (path === null || !root || (path !== '' && !validFilePath(path))) return;
	return { root, path, line: path ? fileLine(url.searchParams.get('line')) : undefined };
}
export function withFile(url: Pick<URL, 'pathname' | 'search' | 'hash'>, file?: FileLocation): string {
	const params = new URLSearchParams(url.search);
	params.delete('file'); params.delete('line'); params.delete('root');
	if (file) {
		params.set('file', file.path);
		if (file.line) params.set('line', String(file.line));
		if (file.root.kind !== 'project') params.set('root', codeRootKey(file.root));
	}
	return url.pathname + (params.size ? `?${params}` : '') + url.hash;
}
/** Conservative path:line recognition, not URL or drive-letter recognition. Existence is resolved on open. */
export function fileReferences(text: string) {
	const pattern = /(?:^|[\s(`\["'])((?:[\p{L}\p{N}._@-]+\/)*[\p{L}\p{N}._@-]+):([1-9]\d{0,8})(?=$|[\s)`\]"',;.!?])/gu;
	return [...text.matchAll(pattern)].flatMap(match => {
		const path = match[1]!, line = fileLine(match[2]);
		if (!line || !validFilePath(path) || !/[/.]/.test(path)) return [];
		const label = `${path}:${line}`;
		return [{ path, line, label, offset: match.index + match[0].length - label.length }];
	});
}
