import { expect, test, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_FEATURES, LEGACY_HARNESS_FEATURES } from '@kemiri/protocol';
import { ArtifactThumbnails } from '../src/artifact-thumbnails.ts';
import { ArtifactStore, ArtifactUrlSigner, serveArtifact } from '../src/artifacts.ts';

const webp = Buffer.from('RIFF0000WEBP');

test('clients only request previews from a backend advertising support', () => {
	expect(HARNESS_FEATURES).toContain('artifact-thumbnails');
	expect(LEGACY_HARNESS_FEATURES).not.toContain('artifact-thumbnails');
});

test('thumbnails deduplicate and cache each immutable version on disk', async () => {
	const root = await mkdtemp(join(tmpdir(), 'artifact-thumbnails-'));
	try {
		const versions = [join(root, 'first', 'page.html'), join(root, 'second', 'page.html')];
		await Promise.all(versions.map((file, index) => Bun.write(file, `<h1>Page ${index + 1}</h1>`)));
		const calls: string[] = [];
		const render = async (html: string) => { calls.push(html); return webp; };
		const thumbnails = new ArtifactThumbnails(render);
		expect(await thumbnails.find(versions[0]!, false)).toBeUndefined();
		const [first, duplicate, second] = await Promise.all([
			thumbnails.find(versions[0]!, true), thumbnails.find(versions[0]!, true), thumbnails.find(versions[1]!, true),
		]);
		expect(first).toBe(duplicate);
		expect(second).not.toBe(first);
		expect(new Uint8Array(await Bun.file(first!).arrayBuffer())).toEqual(new Uint8Array(webp));
		expect(await new ArtifactThumbnails(render).find(versions[0]!, true)).toBe(first);
		expect(calls).toEqual(['<h1>Page 1</h1>', '<h1>Page 2</h1>']);
		const large = join(root, 'large.html');
		await Bun.write(large, ' '.repeat(1024 * 1024 + 1));
		expect(await thumbnails.find(large, true)).toBeUndefined();
		expect(calls).toHaveLength(2);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('a preview needs the original artifact token and never serves HTML as an image', async () => {
	const root = await mkdtemp(join(tmpdir(), 'artifact-thumbnail-http-'));
	try {
		const sourcePath = join(root, 'page.html');
		await Bun.write(sourcePath, '<h1>A garden</h1>');
		const store = new ArtifactStore({ dataDir: root });
		const artifact = await store.save({ sourcePath, projectId: 'p', taskId: null, threadId: 'main', workerId: null });
		const fake = new ArtifactThumbnails(async () => webp);
		const find = spyOn(store.thumbnails, 'find').mockImplementation((...params) => fake.find(...params));
		const signer = new ArtifactUrlSigner({ secret: Buffer.alloc(32, 1) });
		const opts = { store, signer, allowedOrigins: [] };
		const target = `https://example.test${signer.sign('p', `${artifact.id}~1`, 'inline').path}`;
		const invalid = await serveArtifact(new Request(`${target}&preview=1&ignored=value`.replace(/token=[^&]+/, 'token=invalid')), opts);
		expect(invalid?.status).toBe(403);
		expect(find).not.toHaveBeenCalled();
		expect((await serveArtifact(new Request(`${target}&preview=1`, { method: 'HEAD' }), opts))?.status).toBe(404);
		const preview = await serveArtifact(new Request(`${target}&preview=1`), opts);
		expect(preview?.headers.get('content-type')).toBe('image/webp');
		expect(new Uint8Array(await preview!.arrayBuffer())).toEqual(new Uint8Array(webp));
		const raw = await serveArtifact(new Request(target), opts);
		expect(await raw?.text()).toBe('<h1>A garden</h1>');
		const cached = await fake.find(store.filePath(artifact), false);
		await store.delete('p', artifact.id);
		expect(await Bun.file(cached!).exists()).toBe(false);
		expect((await serveArtifact(new Request(`${target}&preview=1`), opts))?.status).toBe(404);
	} finally { await rm(root, { recursive: true, force: true }); }
});
