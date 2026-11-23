import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compile, compileModule } from 'svelte/compiler';
import { renderChromiumDocument } from './support/chromium';

let directory: string;
let result: {
	registered: string[];
	fallbacks: string[];
	initial: string;
	switched: string;
	persisted: string;
	otherTab: string;
	openSheetUnchanged: boolean;
};

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), 'kemiri-task-view-'));
	const root = resolve(import.meta.dir, '..');
	const entry = join(root, 'test/fixtures/task-view/entry.ts');
	const transpiler = new Bun.Transpiler({ loader: 'ts' });
	const bundle = await Bun.build({
		entrypoints: [entry], target: 'browser', tsconfig: join(root, 'tsconfig.json'),
		plugins: [{ name: 'task-view-test', setup(build) {
			// Exercise the actual registry and reactive preference without the full application component tree.
			build.onResolve({ filter: /^#lib\/components\/task-view\/ClassicTaskView\.svelte$/ }, () => ({
				path: join(root, 'test/fixtures/task-view/ClassicFixture.svelte'),
			}));
			build.onLoad({ filter: /\.svelte$/ }, async ({ path: filename }) => ({
				contents: compile(await Bun.file(filename).text(), { filename, generate: 'client' }).js.code, loader: 'js',
			}));
			build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path: filename }) => ({
				contents: compileModule(transpiler.transformSync(await Bun.file(filename).text()), { filename, generate: 'client' }).js.code, loader: 'js',
			}));
		} }],
	});
	const document = join(directory, 'index.html');
	await Bun.write(document, `<main></main><script>addEventListener('error', e => document.body.appendChild(document.createElement('output')).textContent = e.message);localStorage.setItem('kemiri.task-view-design.v1', 'route')</script><script type="module">${(await bundle.outputs[0]!.text()).replaceAll('</script', '<\\/script')}</script>`);
	const dom = await renderChromiumDocument(document, join(directory, 'profile'));
	const json = dom.match(/<pre id="result">(.+)<\/pre>/)?.[1];
	if (!json) throw new Error('Task view design fixture did not render: ' + (dom.match(/<output>(.+)<\/output>/s)?.[1] ?? dom.slice(-600)));
	result = JSON.parse(json);
}, 20000);

afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('Classic is the only registered design and missing, unknown or retired IDs fall back to it', () => {
	expect(result.registered).toEqual(['classic: Classic']);
	expect(result.fallbacks).toEqual(['classic', 'classic', 'classic']);
	expect(result.initial).toBe('Classic: An example task');
});

test('switching redraws the same open sheet and saves the choice', () => {
	expect(result.switched).toBe('Second: An example task');
	expect(result.persisted).toBe('second');
	expect(result.otherTab).toBe('Classic: An example task');
	expect(result.openSheetUnchanged).toBe(true);
});
