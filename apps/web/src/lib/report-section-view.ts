import type { HarnessClient } from '@kemiri/client';
import type { ReportSectionView } from '@kemiri/protocol';
import { artifactThemeCss, type ArtifactPageTheme } from './artifact-page.js';
import { readArtifactText } from './artifact-text.js';
import { artifactBrowserUrl } from './artifacts.js';

export const SECTION_VIEW_BYTES = 256 * 1024;
export const SECTION_VIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'";
export const SECTION_VIEW_FRAME_POLICY = { sandbox: '', referrerpolicy: 'no-referrer' } as const;

export function isReportSectionView(view: ReportSectionView | undefined): view is ReportSectionView {
	return !!view && /^[\w-]+$/.test(view.artifactId) && typeof view.artifactId === 'string' &&
		Number.isSafeInteger(view.version) && view.version > 0 && typeof view.label === 'string' &&
		view.label.length <= 80 && view.label.trim().length > 0 && !/[\x00-\x1f\x7f\u2028\u2029]/.test(view.label);
}

export async function fetchReportSectionView(
	client: Pick<HarnessClient, 'readArtifactUrl'>, projectId: string, view: ReportSectionView,
	origin: string, signal: AbortSignal, fetcher: typeof fetch = fetch,
): Promise<string> {
	const { url } = await client.readArtifactUrl(projectId, `${view.artifactId}~${view.version}`);
	const { content, truncated } = await readArtifactText(artifactBrowserUrl(url, origin), -1, signal, fetcher, SECTION_VIEW_BYTES, true);
	if (truncated) throw new Error('Incomplete section view');
	return content;
}

export type SanitizedSectionView = { styles: string; body: string };

/** Accept only output from the section sanitizer, never raw artifact bytes. */
export function sectionViewDocument(view: SanitizedSectionView, theme: ArtifactPageTheme): string {
	return `<!doctype html><html data-theme="${theme.mode}"><head><meta http-equiv="Content-Security-Policy" content="${SECTION_VIEW_CSP}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${artifactThemeCss(theme)}:where(body){background:var(--tone-bg,Canvas);color:var(--tone-fg,CanvasText);font:var(--text-task,1rem)/1.5 var(--font-sans,system-ui);overflow-wrap:anywhere}:where(img,svg){max-inline-size:100%;height:auto}</style>${view.styles}</head><body>${view.body}</body></html>`;
}
