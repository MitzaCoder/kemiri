import type { Artifact } from '@kemiri/protocol';
import { artifactTextReadLimit, readArtifactText, ArtifactReadError } from '../artifact-text.js';
import { isHtmlArtifact } from '../artifact-preview.js';
import { CODE_VIEW_BYTES, fitsCodeView } from './limits.js';

export function artifactComparisonPair(versions: readonly Artifact[], viewedVersion: number | undefined): { before: Artifact; after: Artifact } | undefined {
	const at = versions.findIndex(version => version.version === viewedVersion);
	const viewed = versions[at];
	if (viewed?.kind !== 'text') return;
	const adjacent = versions[at - 1] ?? versions[at + 1];
	if (adjacent?.kind !== 'text') return;
	return at > 0 ? { before: adjacent, after: viewed } : { before: viewed, after: adjacent };
}

export type ComparisonText = { content: string; truncated: boolean };

export function comparisonState(before: ComparisonText, after: ComparisonText): 'too-large' | 'same' | 'changes' {
	if (before.truncated || after.truncated || !fitsCodeView(before.content) || !fitsCodeView(after.content)) return 'too-large';
	const normalize = (text: string) => text.replace(/\r\n?/g, '\n');
	return normalize(before.content) === normalize(after.content) ? 'same' : 'changes';
}

export async function readComparisonVersion(version: Artifact, sign: () => Promise<{ url: string }>, signal: AbortSignal): Promise<ComparisonText> {
	const limit = Math.min(CODE_VIEW_BYTES, artifactTextReadLimit(isHtmlArtifact(version)));
	for (let attempt = 0; ; attempt++) {
		const { url } = await sign();
		signal.throwIfAborted();
		try { return await readArtifactText(url, version.size, signal, fetch, limit); }
		catch (error) {
			if (attempt || !(error instanceof ArtifactReadError) || ![401, 403, 410].includes(error.status)) throw error;
		}
	}
}
