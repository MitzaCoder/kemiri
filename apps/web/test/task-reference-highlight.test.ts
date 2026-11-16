import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderChromiumDocument } from './support/chromium';

test('references tint only matching visible rows/cards, clear on leave, and never scroll', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'kemiri-task-highlight-'));
	try {
		const entry = join(directory, 'entry.ts');
		await Bun.write(entry, `
			import { observeTaskReferences } from ${JSON.stringify(resolve(import.meta.dir, '../src/lib/task-reference-highlight.ts'))};
			const href = location.href + '?task=T12';
			document.body.innerHTML = '<a id="ref" href="' + href + '"><span>T12</span></a>' +
				'<div class="task-row" data-task="T12" id="row" data-no-task-preview><a id="nav" href="' + href + '">Row</a></div>' +
				'<article class="task-card" data-task="T12" id="card">Card</article>' +
				'<article class="task-card" data-task="T13" id="other">Other</article>' +
				'<div style="overflow:hidden;height:10px"><div style="height:90px"></div><div class="task-row" data-task="T12" id="clipped">Clipped</div></div>' +
				'<div style="display:none" class="task-row" data-task="T12" id="hidden">Hidden</div>';
			const dispose = observeTaskReferences();
			const results = {};
			const ref = document.getElementById('ref');
			const highlighted = id => document.getElementById(id).classList.contains('task-reference-highlight');
			const hover = target => target.dispatchEvent(new PointerEvent('pointerover', {bubbles:true, pointerType:'mouse'}));
			const scroll = [scrollX, scrollY];
			hover(ref.firstElementChild);
			results.targets = ['row','card','other','clipped','hidden'].map(highlighted);
			results.noScroll = scrollX === scroll[0] && scrollY === scroll[1];
			const animationClass = document.getElementById('row').className;
			hover(ref);
			results.stable = document.getElementById('row').className === animationClass;
			ref.dispatchEvent(new PointerEvent('pointerout', {bubbles:true,pointerType:'mouse',relatedTarget:document.body}));
			results.leave = highlighted('row');
			ref.dispatchEvent(new FocusEvent('focusin', {bubbles:true}));
			results.focus = highlighted('row');
			ref.dispatchEvent(new FocusEvent('focusout', {bubbles:true,relatedTarget:document.body}));
			results.blur = highlighted('row');
			hover(document.getElementById('nav'));
			results.navigationExcluded = highlighted('row');
			ref.dispatchEvent(new PointerEvent('pointerover', {bubbles:true,pointerType:'touch'}));
			results.touchIgnored = highlighted('row');
			hover(ref); document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}));
			results.escape = highlighted('row');
			hover(ref); dispose(); results.disposed = highlighted('row');
			document.body.innerHTML = '<pre id="results">' + btoa(JSON.stringify(results)) + '</pre>';
		`);
		const bundle = await Bun.build({ entrypoints: [entry], target: 'browser', minify: true });
		if (!bundle.success) throw new Error('Could not bundle task highlight test');
		const document = join(directory, 'index.html');
		await Bun.write(document, `<body><script type="module">${(await bundle.outputs[0]!.text()).replaceAll('</script', '<\\/script')}</script></body>`);
		const dom = await renderChromiumDocument(document, join(directory, 'profile'));
		const encoded = [...dom.matchAll(/<pre id="results">([A-Za-z0-9+/=]+)<\/pre>/g)].at(-1)?.[1];
		if (encoded === undefined) throw new Error('Missing task highlight results');
		expect(JSON.parse(Buffer.from(encoded, 'base64').toString())).toEqual({
			targets: [true, true, false, false, false], noScroll: true, stable: true,
			leave: false, focus: true, blur: false, navigationExcluded: false,
			touchIgnored: false, escape: false, disposed: false,
		});
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('identity chips and one-shot reduced-motion highlight stay shared across surfaces', async () => {
	for (const component of ['TasksPanel', 'TaskCard', 'TaskFamilyMeta', 'TaskRelationChips']) {
		expect(await Bun.file(resolve(import.meta.dir, `../src/lib/components/${component}.svelte`)).text()).toContain('<TaskIdChip');
	}
	const css = await Bun.file(resolve(import.meta.dir, '../src/lib/themes/base.css')).text();
	expect(css).toContain('task-reference-pulse 700ms ease-out 1');
	expect(css).toContain('@media (prefers-reduced-motion: reduce)');
});
