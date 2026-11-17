import { expect, test } from 'bun:test';
import { PagePreviewPool, PAGE_PREVIEW_BYTES } from '../src/lib/page-preview.ts';
import { pagesFirst, ARTIFACT_FRAME_SANDBOX } from '../src/lib/artifact-preview.ts';

test('page prominence is a stable partition, including MIME-only pages; input is unchanged', () => {
	const files = [
		{ name: 'notes.txt', mimeType: 'text/plain' },
		{ name: 'report.HTML', mimeType: 'application/octet-stream' },
		{ name: 'photo.png', mimeType: 'image/png' },
		{ name: 'page', mimeType: 'text/html; charset=utf-8' },
		{ name: 'walk.mp4', mimeType: 'video/mp4' }
	];
	expect(pagesFirst(files).map(f => f.name)).toEqual(['report.HTML', 'page', 'notes.txt', 'photo.png', 'walk.mp4']);
	expect(files[0]!.name).toBe('notes.txt');
});

test('only the budgeted live previews start; queued hidden cells can cancel', () => {
	const pool = new PagePreviewPool(2);
	const started: number[] = [];
	const release = [0, 1, 2, 3].map(n => pool.reserve(() => started.push(n)));
	expect(started).toEqual([0, 1]);
	release[2]!(); // hidden while waiting: it must never start
	release[0]!();
	expect(started).toEqual([0, 1, 3]);
	release[0]!(); // double release must not create a phantom slot
	const last = pool.reserve(() => started.push(4));
	expect(started).toEqual([0, 1, 3]);
	release[1]!();
	expect(started).toEqual([0, 1, 3, 4]);
	release[3]!(); last();
});

test('preview limits are small and the shared sandbox never grants an app origin', () => {
	expect(PAGE_PREVIEW_BYTES).toBe(1024 * 1024);
	expect(ARTIFACT_FRAME_SANDBOX).not.toContain('allow-same-origin');
	for (const limit of [0, -1, 1.5, NaN]) expect(() => new PagePreviewPool(limit)).toThrow();
});

test('gallery frames share viewer policy, are inert, and do not mount offscreen or beyond the pool', async () => {
	const source = await Bun.file(new URL('../src/lib/components/artifacts/ArtifactPageThumb.svelte', import.meta.url)).text();
	expect(source).toContain('new IntersectionObserver');
	expect(source).toContain('pagePreviewPool.reserve');
	expect(source).toContain('sandbox={ARTIFACT_FRAME_SANDBOX}');
	expect(source).toContain('referrerpolicy="no-referrer"');
	expect(source).toContain('tabindex="-1" inert');
	expect(source).toContain('project === undefined || project.blockArtifactRequests === true');
	expect(source).toContain('blockRequests, true, false');
	expect(source).toContain('preview.truncated ? undefined');
	expect(source).toContain('controller.abort()');
});
