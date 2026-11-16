import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { ARTIFACT_REVIEW_PRELUDE } from '../src/lib/artifact-review-frame.ts';

function frame() {
	const listeners = new Map<string, ((event: any) => void)[]>();
	const messages: unknown[] = [];
	const parent = { postMessage: (message: unknown) => messages.push(message) };
	class Element {
		tagName = 'svg'; textContent = ''; attributes: Record<string, string> = { 'aria-label': 'Before 410 After 312' };
		closest(selector: string) { return selector === '[id]' ? null : this; }
		getAttribute(key: string) { return this.attributes[key] ?? null; }
		setAttribute(key: string, value: string) { this.attributes[key] = value; }
		removeAttribute(key: string) { delete this.attributes[key]; }
		querySelector() { return null; }
		scrollIntoView() {}
	}
	const chart = new Element();
	const root = new Element();
	const document = {
		documentElement: root, head: { appendChild() {} }, createElement: () => ({textContent:''}),
		querySelectorAll: (selector: string) => selector.startsWith('h1') ? [] : [chart],
		addEventListener: (name: string, fn: (event: any) => void) => { listeners.set(name, [...listeners.get(name) ?? [], fn]); },
	};
	runInNewContext(ARTIFACT_REVIEW_PRELUDE, { parent, document, Element, Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, window: document, clearTimeout() {}, setTimeout: (fn: () => void) => { fn(); }, getSelection: () => ({ toString: () => 'Selected words', anchorNode: null }) });
	const emit = (name: string, event: unknown) => listeners.get(name)?.forEach(fn => fn(event));
	const control = (data: string, source: unknown = parent) => emit('message', { source, data });
	return { messages, chart, root, emit, control };
}

test('only exact parent controls enter block mode; a picked chart emits text, not markup', () => {
	const view = frame();
	view.control('kemiri:pick-artifact-block', {});
	expect(view.root.attributes['data-kemiri-review-picking']).toBeUndefined();
	view.control('anything'); expect(view.messages).toEqual([]);
	view.control('kemiri:pick-artifact-block');
	view.emit('pointerover', { target: view.chart });
	expect(view.chart.attributes['data-kemiri-review-pick']).toBe('');
	let prevented = 0;
	view.emit('click', { target: view.chart, preventDefault() { prevented++; }, stopImmediatePropagation() { prevented++; } });
	expect(prevented).toBe(2);
	expect(view.messages).toEqual([{ type: 'kemiri:artifact-selection', text: 'Before 410 After 312', section: '', elementId: '', block: 'chart' }]);
	expect(view.chart.attributes['data-kemiri-review-pick']).toBeUndefined();
	expect(view.root.attributes['data-kemiri-review-picking']).toBeUndefined();
});

test('cancel and Escape stop picking without sending a block or closing the viewer', () => {
	const view=frame(); view.control('kemiri:pick-artifact-block'); view.control('kemiri:cancel-artifact-pick');
	expect(view.messages).toEqual([]);
	view.control('kemiri:pick-artifact-block');
	view.emit('keydown',{key:'Escape',preventDefault(){},stopImmediatePropagation(){}});
	expect(view.messages).toEqual([{type:'kemiri:artifact-selection',text:'',section:'',elementId:''}]);
});

test('keyboard arrows outline a candidate and Enter picks it; selection reports are the same message type', () => {
	const view=frame(); view.control('kemiri:pick-artifact-block');
	view.emit('keydown',{key:'ArrowDown',preventDefault(){},stopImmediatePropagation(){}});
	expect(view.chart.attributes['data-kemiri-review-pick']).toBe('');
	view.emit('keydown',{key:'Enter',target:null,preventDefault(){},stopImmediatePropagation(){}});
	expect(view.messages).toHaveLength(1);
	view.emit('selectionchange',{});
	expect(view.messages[1]).toEqual({type:'kemiri:artifact-selection',text:'Selected words',section:'',elementId:''});
});
