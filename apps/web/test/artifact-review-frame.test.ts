import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { ARTIFACT_REVIEW_PRELUDE } from '../src/lib/artifact-review-frame.ts';

// Execute the shipped Android scripts too: the two transports must pick the same blocks.
const androidSource = readFileSync(new URL('../../android/app/src/main/kotlin/io/github/mitzacoder/kemiri/features/chat/ArtifactReviewPage.kt', import.meta.url), 'utf8');
const androidScript = (name: string) => androidSource.match(new RegExp(`val ${name} = """([\\s\\S]*?)"""`))![1]!;

class Element {
	attributes: Record<string, string>;
	children: Element[] = [];
	parentElement: Element | null = null;
	display = 'block'; visibility = 'visible'; width = 100; height = 40;
	constructor(public tagName = 'svg', attributes: Record<string, string> = {}, public textContent = '') { this.attributes = attributes; }
	get id() { return this.attributes.id; }
	get innerText() { return this.textContent; }
	append(child: Element) { child.parentElement = this; this.children.push(child); return child; }
	matches(selector: string): boolean { return selector.split(',').some(part => part === this.tagName || (part === '[id]' && !!this.id) || (part === '[role="img"]' && this.attributes.role === 'img')); }
	closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
	all(): Element[] { return this.children.flatMap(child => [child, ...child.all()]); }
	querySelector(selector: string) { return this.all().find(child => child.matches(selector)) ?? null; }
	getAttribute(key: string) { return this.attributes[key] ?? null; }
	setAttribute(key: string, value: string) { this.attributes[key] = value; }
	removeAttribute(key: string) { delete this.attributes[key]; }
	getBoundingClientRect() { return { width: this.width, height: this.height }; }
	scrollIntoView() {}
}

function frame(platform: 'web' | 'android', elements: Element[] = [new Element('svg', { 'aria-label': 'Before 410 After 312' })]) {
	const listeners = new Map<string, ((event: any) => void)[]>();
	const messages: any[] = [];
	const parent = { postMessage: (message: unknown) => messages.push(message) };
	const root = new Element('html'), body = root.append(new Element('body'));
	for (const element of elements) body.append(element);
	const document = {
		documentElement: root, body, head: { appendChild() {} }, createElement: () => ({textContent:''}),
		getElementById: (id: string) => body.all().find(element => element.id === id),
		querySelectorAll: (selector: string) => selector === 'body *' ? body.all() : [],
		addEventListener: (name: string, fn: (event: any) => void) => { listeners.set(name, [...listeners.get(name) ?? [], fn]); },
	};
	const selection = { text: 'Selected words', toString() { return this.text; }, anchorNode: null, removeAllRanges() { this.text = ''; } };
	const context = createContext({ parent, document, Element, Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, window: document, clearTimeout() {}, setTimeout: (fn: () => void) => { fn(); }, getSelection: () => selection, getComputedStyle: (element: Element) => element });
	runInContext(platform === 'web' ? ARTIFACT_REVIEW_PRELUDE : androidScript('ARTIFACT_REVIEW_READ'), context);
	const emit = (name: string, event: unknown) => listeners.get(name)?.forEach(fn => fn(event));
	function control(data: string, source: unknown = parent) {
		if (platform === 'web') emit('message', { source, data });
		else if (source === parent && data === 'kemiri:pick-artifact-block') runInContext(androidScript('ARTIFACT_REVIEW_PICK'), context);
		else if (source === parent && data === 'kemiri:cancel-artifact-pick') runInContext(androidScript('ARTIFACT_REVIEW_CANCEL_PICK'), context);
	}
	function read() {
		if (platform === 'web') emit('selectionchange', {});
		else { const result = runInContext(androidScript('ARTIFACT_REVIEW_READ'), context); if (result) messages.push(JSON.parse(result)); }
	}
	function click(target: Element) { emit('click', { target, preventDefault() {}, stopImmediatePropagation() {} }); if (platform === 'android') read(); }
	function key(key: string) { emit('keydown', { key, target: body, preventDefault() {}, stopImmediatePropagation() {} }); if (platform === 'android' && (key === 'Enter' || key === 'Escape')) read(); }
	return { messages, chart: elements[0]!, root, emit, control, read, click, key, selection };
}

for (const platform of ['web', 'android'] as const) {
	test(`${platform}: only exact controls enter block mode; a chart emits text, not markup`, () => {
		const view = frame(platform);
		view.control('kemiri:pick-artifact-block', {});
		expect(view.root.attributes['data-kemiri-review-picking']).toBeUndefined();
		view.control('anything'); expect(view.messages).toEqual([]);
		view.control('kemiri:pick-artifact-block');
		view.emit('pointerover', { target: view.chart });
		expect(view.chart.attributes['data-kemiri-review-pick']).toBe('');
		view.click(view.chart);
		expect(view.messages).toEqual([{ type: 'kemiri:artifact-selection', text: 'Before 410 After 312', section: '', elementId: '', block: 'chart' }]);
		expect(view.chart.attributes['data-kemiri-review-pick']).toBeUndefined();
		expect(view.root.attributes['data-kemiri-review-picking']).toBeUndefined();
	});

	test(`${platform}: cancel and Escape remove highlights without closing the viewer`, () => {
		const view = frame(platform); view.control('kemiri:pick-artifact-block'); view.emit('pointerover', { target: view.chart }); view.control('kemiri:cancel-artifact-pick');
		expect(view.messages).toEqual([]); expect(view.chart.attributes['data-kemiri-review-pick']).toBeUndefined();
		view.control('kemiri:pick-artifact-block'); view.key('Escape');
		expect(view.messages).toEqual([{type:'kemiri:artifact-selection',text:'',section:'',elementId:''}]);
	});

	test(`${platform}: keyboard skips hidden blocks; Enter chooses the outlined block, not the focused body`, () => {
		const hidden = new Element('div'); hidden.visibility = 'hidden';
		const view = frame(platform, [hidden, new Element('svg', { 'aria-label': 'Chart' })]); view.control('kemiri:pick-artifact-block'); view.key('ArrowDown'); view.key('Enter');
		expect(view.messages[0].text).toBe('Chart');
		view.selection.text = 'Selected words'; view.read();
		expect(view.messages[1]).toEqual({type:'kemiri:artifact-selection',text:'Selected words',section:'',elementId:''});
	});

	test(`${platform}: role=img targets the whole labelled mock-up from deeply nested rows`, () => {
		const mock = new Element('div', { role: 'img', 'aria-label': 'Bakery board mock-up', id: 'mock' });
		const row = mock.append(new Element('div')).append(new Element('span', {}, 'Fix the till')); row.display = 'inline';
		const view = frame(platform, [mock]); view.control('kemiri:pick-artifact-block'); view.emit('pointerover', { target: row });
		expect(mock.attributes['data-kemiri-review-pick']).toBe('');
		view.click(row); expect(view.messages[0]).toEqual({type:'kemiri:artifact-selection',text:'Bakery board mock-up',section:'',elementId:'mock',block:'image'});
	});

	for (const [tag, attributes, text, expected, block] of [
		['svg', {}, 'Sales chart title', 'Sales chart title', 'chart'],
		['img', { alt: 'Bakery logo' }, '', 'Bakery logo', 'image'],
		['canvas', {}, '', 'chart (canvas)', 'chart'],
		['div', { style: 'user-select:none' }, 'Unselectable text', 'Unselectable text', 'block'],
		['p', {}, 'Plain selectable text', 'Plain selectable text', 'paragraph'],
		['div', {}, '', 'block (div)', 'block'],
	] as const) test(`${platform}: ${tag} ${expected} can be picked without a text Range`, () => {
		const element = new Element(tag, attributes, text), view = frame(platform, [element]);
		view.control('kemiri:pick-artifact-block'); view.click(element);
		expect(view.messages[0].text).toBe(expected); expect(view.messages[0].block).toBe(block);
	});

	test(`${platform}: generic nested flex/grid rows pick the nearest layout block; labels and headings describe it`, () => {
		const outer = new Element('div'); outer.display = 'grid';
		const row = outer.append(new Element('div', { 'aria-labelledby': 'row-label' })); row.display = 'flex';
		const span = row.append(new Element('span', { id: 'row-label' }, 'Nested row')); span.display = 'inline';
		const view = frame(platform, [outer]); view.control('kemiri:pick-artifact-block'); view.click(span);
		expect(view.messages[0].text).toBe('Nested row'); expect(view.messages[0].elementId).toBe('');
		row.attributes = {}; row.append(new Element('h3', {}, 'Row heading'));
		view.control('kemiri:pick-artifact-block'); view.click(row); expect(view.messages[1].text).toBe('Row heading');
	});
}

test('web: an empty text-selection event after a block click does not erase the picked block', () => {
	const view = frame('web'); view.control('kemiri:pick-artifact-block'); view.click(view.chart);
	view.selection.text = ''; view.read(); expect(view.messages).toHaveLength(1);
	view.selection.text = 'New text selection'; view.read(); expect(view.messages[1].text).toBe('New text selection');
	view.selection.text = ''; view.read(); expect(view.messages[2].text).toBe('');
});
