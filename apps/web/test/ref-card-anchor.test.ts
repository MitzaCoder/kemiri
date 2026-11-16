import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderChromiumDocument } from './support/chromium';

test('task navigation containers opt out without disabling prose or external reference previews', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'kemiri-ref-anchor-'));
	try {
		const entry = join(directory, 'entry.ts');
		await Bun.write(entry, `
			import { refCardAnchor } from ${JSON.stringify(resolve(import.meta.dir, '../src/lib/ref-card-anchor.ts'))};
			const page = 'https://app.example.test/b/demo/projects/sample';
			const link = (id, text = 'T12') => '<a href="' + page + '?task=T12"><span id="' + id + '">' + text + '</span></a>';
			document.body.innerHTML =
				'<section data-no-task-preview>' + link('own-id') + link('title', 'Compare T13 and T14') +
				'<div>' + link('summary') + '</div><a href="https://github.com/example/repo/issues/12"><span id="external">#12</span></a></section>' +
				'<article>' + link('description') + link('report') + link('question') + link('decision') + link('feedback') + link('timeline') + link('chat') + '</article>' +
				'<div data-ref-card>' + link('inside-preview') + '</div>' +
				'<a data-no-ref-card href="' + page + '?task=T12"><span id="disabled">T12</span></a>';
			const results = {};
			for (const id of ['own-id', 'title', 'summary', 'external', 'description', 'report', 'question', 'decision', 'feedback', 'timeline', 'chat', 'inside-preview', 'disabled']) {
				results[id] = !!refCardAnchor(document.getElementById(id), page);
			}
			document.body.innerHTML = '<pre id="results">' + btoa(JSON.stringify(results)) + '</pre>';
		`);
		const bundle = await Bun.build({ entrypoints: [entry], target: 'browser', minify: true });
		if (!bundle.success) throw new Error('Could not bundle reference anchor test');
		const document = join(directory, 'index.html');
		await Bun.write(document, `<body><script type="module">${(await bundle.outputs[0]!.text()).replaceAll('</script', '<\\/script')}</script></body>`);
		const dom = await renderChromiumDocument(document, join(directory, 'profile'));
		const encoded = [...dom.matchAll(/<pre id="results">([A-Za-z0-9+/=]+)<\/pre>/g)].at(-1)?.[1];
		if (encoded === undefined) throw new Error('Missing reference anchor results');
		expect(JSON.parse(Buffer.from(encoded, 'base64').toString())).toEqual({
			'own-id': false, title: false, summary: false, external: true,
			description: true, report: true, question: true, decision: true, feedback: true, timeline: true, chat: true,
			'inside-preview': false, disabled: false,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('task navigation surfaces declare the opt-out, including shared sidebar and search rows', async () => {
	for (const component of ['TasksPanel', 'TaskCard', 'TaskGraph', 'NeedsYou']) {
		const source = await Bun.file(resolve(import.meta.dir, `../src/lib/components/${component}.svelte`)).text();
		expect(source).toContain('data-no-task-preview');
	}
});
