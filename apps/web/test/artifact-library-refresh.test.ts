import { expect, test } from 'bun:test';
import { ArtifactLibraryRefresh } from '../src/lib/artifact-library-refresh.js';

test('catalogue loads on route entry, not for background artifact pushes or retries', async () => {
	let loads = 0;
	const refresh = new ArtifactLibraryRefresh(async () => { loads++; }, 5);
	refresh.artifactsChanged();
	refresh.refresh();
	await Bun.sleep(15);
	expect(loads).toBe(0);
	refresh.setActive(true);
	expect(loads).toBe(1);
	refresh.artifactsChanged();
	refresh.artifactsChanged();
	await Bun.sleep(15);
	expect(loads).toBe(2);
	refresh.artifactsChanged();
	refresh.setActive(false);
	await Bun.sleep(15);
	expect(loads).toBe(2);
	refresh.setActive(true);
	expect(loads).toBe(3);
	refresh.setActive(false);
});

test('route exit and changes invalidate pagination without overlapping requests', async () => {
	const pages: { isCurrent(): boolean; settle(): void }[] = [];
	const refresh = new ArtifactLibraryRefresh(isCurrent => new Promise<void>(settle => pages.push({ isCurrent, settle })), 5);
	refresh.setActive(true);
	expect(pages[0]!.isCurrent()).toBe(true);
	refresh.artifactsChanged();
	await Bun.sleep(15);
	expect(pages[0]!.isCurrent()).toBe(false);
	expect(pages).toHaveLength(1);
	pages[0]!.settle();
	await Bun.sleep(0);
	expect(pages).toHaveLength(2);
	refresh.setActive(false);
	expect(pages[1]!.isCurrent()).toBe(false);
	pages[1]!.settle();
	await Bun.sleep(0);
	expect(pages).toHaveLength(2);
});
