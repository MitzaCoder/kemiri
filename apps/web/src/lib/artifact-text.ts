import { TEXT_PREVIEW_BYTES } from './artifacts.js';

/** Embedded screenshots easily exceed text previews; cap source reads at 20 MiB on both clients. */
export const ARTIFACT_HTML_PAGE_BYTES = 20 * 1024 * 1024;
export function artifactTextReadLimit(html: boolean): number {
	return html ? ARTIFACT_HTML_PAGE_BYTES : TEXT_PREVIEW_BYTES;
}

export class ArtifactReadError extends Error {
	constructor(readonly status: number) {
		super(`The backend answered ${status}.`);
	}
}

export function artifactReadProblem(error: unknown): string {
	if (error instanceof TypeError) {
		return 'Could not reach the artifact. Check the backend connection and retry. The browser may have blocked the request or the connection was interrupted.';
	}
	return error instanceof Error ? error.message : String(error);
}

/** Small reports use an ordinary GET; larger/unknown files request a bounded preview.
 * Bound the read even when a proxy ignores Range. No text is shown from an interrupted body.
 */
export async function readArtifactText(
	url: string,
	size: number,
	signal: AbortSignal,
	fetcher: typeof fetch = fetch,
	limit = TEXT_PREVIEW_BYTES,
	strictHtml = false,
): Promise<{ content: string; truncated: boolean }> {
	const response = await fetcher(url, {
		...(size >= 0 && size <= limit ? {} : { headers: { Range: `bytes=0-${limit}` } }),
		signal,
	});
	if (!response.ok) throw new ArtifactReadError(response.status);
	const range = response.headers.get('content-range') ?? '';
	const total = Number(/\/(\d+)$/.exec(range)?.[1] ?? size);
	if (strictHtml && (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/html' ||
		(response.status !== 200 && (response.status !== 206 || !/^bytes 0-\d+\/\d+$/.test(range) || range !== `bytes 0-${total - 1}/${total}`)) ||
		total > limit)) {
		await response.body?.cancel().catch(() => {});
		throw new Error('Unsupported or incomplete HTML');
	}
	const reader = response.body?.getReader();
	if (!reader) return { content: '', truncated: false };
	const chunks: Uint8Array[] = [];
	let length = 0;
	let done = false;
	try {
		while (length <= limit) {
			const next = await reader.read();
			if (next.done) { done = true; break; }
			const chunk = next.value.subarray(0, limit + 1 - length);
			chunks.push(chunk);
			length += chunk.length;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
	return { content: new TextDecoder('utf-8', { fatal: strictHtml }).decode(bytes.subarray(0, limit)), truncated: length > limit || length < total || (!done && total < 0) };
}
