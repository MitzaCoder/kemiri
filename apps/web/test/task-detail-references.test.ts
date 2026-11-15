import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { taskIdFromHref } from '../src/lib/task-chat.ts';
import { renderChromiumDocument } from './support/chromium';

let directory: string;
let result: Record<string, { tasks: string[]; links: string[]; code: string[]; html: string }>;
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), 'kemiri-task-refs-'));
	const entry = join(directory, 'render.ts');
	await Bun.write(entry, `
		import { toBlocks } from ${JSON.stringify(resolve(import.meta.dir, '../src/lib/markdown/parse.ts'))};
		const results = {};
		const samples = ${JSON.stringify({
			prose: '**T12** and T12, T999, Q1, D1.\n\n- T12\n\n> T12\n\n| Task |\n|---|\n| T12 |',
			protected: '`T12` and ``T12`x`` and [**T12**](https://example.com/a_(b)) and [T12][ref]\n\n[ref]: https://example.com\n\n    T12\n\n```text\nT12\n```',
			escaped: 'T12 & <script>alert(1)</script> [unsafe](javascript:alert(1))',
			streaming: 'See T12',
		})};
		for (const [name, source] of Object.entries(samples)) for (const user of [false, true]) {
			const blocks = toBlocks(source, name === 'streaming', user, id => id === 'T12' ? 'Task twelve' : undefined);
			const el = document.createElement('div');
			el.innerHTML = blocks.filter(b => b.kind === 'html').map(b => b.html).join('');
			results[name + user] = {tasks:[...el.querySelectorAll('a[href="?task=T12"]')].map(a=>a.textContent), links:[...el.querySelectorAll('a')].map(a=>a.getAttribute('href')), code:[...el.querySelectorAll('code')].map(c=>c.textContent), html:el.innerHTML};
		}
		// A task appearing/disappearing on the board must invalidate rendered block caching.
		for (const known of [false, true, false]) {
			results['cache'+known] = {html: toBlocks('T12', false, false, id => known ? 'Known task' : undefined)[0].html};
		}
		document.body.innerHTML = '<pre id="results">' + btoa(JSON.stringify(results)) + '</pre>';
	`);
	const bundle = await Bun.build({ entrypoints: [entry], target: 'browser', minify: true });
	if (!bundle.success) throw new Error('Could not bundle reference rendering test');
	const document = join(directory, 'index.html');
	await Bun.write(document, `<body><script type="module">${(await bundle.outputs[0]!.text()).replaceAll("</script", "<\\/script")}</script></body>`);
	const dom = await renderChromiumDocument(document, join(directory, 'profile'));
	const encoded = [...dom.matchAll(/<pre id="results">([A-Za-z0-9+/=]+)<\/pre>/g)].at(-1)?.[1];
	if (encoded === undefined) throw new Error('No rendered reference test result');
	result = JSON.parse(Buffer.from(encoded, 'base64').toString());
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe('shared task-detail and chat Markdown references', () => {
	for (const user of [false, true]) {
		test(`formatted prose, lists, quotes and tables link known tasks (${user})`, () => {
			expect(result[`prose${user}`]!.tasks).toEqual(['T12', 'T12', 'T12', 'T12', 'T12']);
		});
		test(`code and existing nested/reference links stay intact (${user})`, () => {
			expect(result[`protected${user}`]!.tasks).toEqual([]);
			expect(result[`protected${user}`]!.links).toEqual(['https://example.com/a_(b)', 'https://example.com']);
			expect(result[`protected${user}`]!.code).toEqual(['T12', 'T12`x']);
			expect(result[`streaming${user}`]!.tasks).toEqual([]);
			expect(result[`escaped${user}`]!.html).not.toContain('<script>');
			expect(result[`escaped${user}`]!.links).not.toContain('javascript:alert(1)');
		});
	}
	test('board changes invalidate link rendering', () => {
		expect(result.cachetrue!.html).toContain('?task=T12');
		expect(result.cachefalse!.html).not.toContain('?task=T12');
	});
	test('preview host accepts only this page’s task links', () => {
		const page = 'https://app.example.test/b/demo/projects/sample?task=T2';
		expect(taskIdFromHref('?task=T12', page)).toBe('T12');
		for (const href of ['https://other.example.test/?task=T12', '/other?task=T12', '?task=Q1', '?task=T12x', 'not a URL']) expect(taskIdFromHref(href, page)).toBeUndefined();
	});
});
