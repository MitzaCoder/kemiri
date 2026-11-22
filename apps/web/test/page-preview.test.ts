import { expect, test } from 'bun:test';
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

test('HTML list previews lazy-load an immutable image and never mount an iframe', async () => {
	const source = await Bun.file(new URL('../src/lib/components/artifacts/ArtifactPageThumb.svelte', import.meta.url)).text();
	expect(source).toContain('use:inView');
	expect(source).toContain('url.searchParams.set(\'preview\', \'1\')');
	expect(source).toContain('artifact.id}~${artifact.version}');
	expect(source).toContain('<img ');
	expect(source).not.toContain('<iframe');
	expect(ARTIFACT_FRAME_SANDBOX).not.toContain('allow-same-origin');
});
