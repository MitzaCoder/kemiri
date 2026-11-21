import { RangeSet, StateEffect, StateField, type Extension } from '@codemirror/state';
import { BlockType, Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, keymap, lineNumberMarkers, type BlockInfo, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { getChunks, getOriginalDoc } from '@codemirror/merge';
import { mount, unmount } from 'svelte';
import LineReviewCard from '../components/review/LineReviewCard.svelte';
import SavedLineComment from '../components/review/SavedLineComment.svelte';
import { anchorCodeLines, type CodeComment, type CodeReviewSource, type CodeSide } from './code-review.js';
import { sameReviewSource, type CodeReviewSession } from './code-review-session.svelte.js';

export type LineReviewTarget = { session: CodeReviewSession; source: CodeReviewSource; path: string; previousPath?: string; disabledSides?: CodeSide[] };
type ReviewDecorations = { widgets: DecorationSet; lineCounts: ReadonlyMap<number, number>; deletedCounts: ReadonlyMap<number, number> };
const emptyReview: ReviewDecorations = { widgets: Decoration.none, lineCounts: new Map(), deletedCounts: new Map() };
const reviewWidgets = StateEffect.define<ReviewDecorations>();
const reviewField = StateField.define<ReviewDecorations>({
	create: () => emptyReview,
	update: (decorations, transaction) => transaction.effects.find(effect => effect.is(reviewWidgets))?.value ?? decorations,
	provide: field => EditorView.decorations.from(field, review => review.widgets),
});

function startLineReview(view: EditorView, target: LineReviewTarget, side: CodeSide, line?: number, original = false): boolean {
	const doc = original ? getOriginalDoc(view.state) : view.state.doc;
	const selection = view.state.selection.main;
	const first = line ?? doc.lineAt(selection.from).number;
	const last = line ?? doc.lineAt(selection.empty ? selection.to : Math.max(selection.from, selection.to - 1)).number;
	const anchor = anchorCodeLines(doc, target.path, side, first, last);
	if (!anchor) {
		target.session.problem = 'Select up to 100 lines and 4,000 characters for one comment.';
		return true;
	}
	target.session.start(target.source, anchor, () => { if (view.dom.isConnected) view.focus(); });
	return true;
}

export function commentOnCode(view: EditorView, target: LineReviewTarget, side: CodeSide): boolean {
	return startLineReview(view, target, side);
}

/** The toolbar takes an explicit selection, or the first visible line rather than a stale cursor. */
export function commentOnVisibleCode(view: EditorView, target: LineReviewTarget, side: CodeSide): boolean {
	const top = Math.max(0, view.scrollDOM.getBoundingClientRect().top, view.dom.closest('.comparison-content')?.getBoundingClientRect().top ?? 0);
	if (target.disabledSides?.includes(side)) {
		const first = [...view.dom.querySelectorAll<HTMLElement>('[data-review-deleted-line]')]
			.find(number => number.getBoundingClientRect().bottom > top);
		return first ? startLineReview(view, target, 'before', Number(first.dataset.reviewDeletedLine), true) : false;
	}
	if (!view.state.selection.main.empty) return commentOnCode(view, target, side);
	const block = view.viewportLineBlocks.flatMap(line => Array.isArray(line.type) ? line.type : [line])
		.find(line => line.type === BlockType.Text && line.bottom > top - view.documentTop &&
			view.visibleRanges.some(range => line.from >= range.from && line.from <= range.to));
	return startLineReview(view, target, side, view.state.doc.lineAt(block?.from ?? view.visibleRanges[0]?.from ?? 0).number);
}

const setHoveredLine = StateEffect.define<number | null>();
const hoveredLine = StateField.define<number | null>({
	create: () => null,
	update(position, transaction) {
		const hover = transaction.effects.find(effect => effect.is(setHoveredLine));
		return hover ? hover.value : position;
	},
});
const setReviewFocus = StateEffect.define<boolean>();
const reviewFocus = StateField.define<boolean>({
	create: () => false,
	update(focused, transaction) { return transaction.effects.find(effect => effect.is(setReviewFocus))?.value ?? focused; },
});

function lineCommentPin(count: number): HTMLSpanElement {
	const pin = document.createElement('span');
	pin.className = 'cm-review-pin';
	pin.textContent = String(count);
	pin.title = `${count} ${count === 1 ? 'comment' : 'comments'}`;
	return pin;
}

class ReviewLineNumber extends GutterMarker {
	constructor(readonly line: number, readonly count: number, readonly showAdd: boolean) { super(); }
	eq(other: ReviewLineNumber) { return this.line === other.line && this.count === other.count && this.showAdd === other.showAdd; }
	toDOM() {
		const number = document.createElement('span');
		number.className = 'cm-review-line-number';
		number.textContent = String(this.line);
		if (this.count) number.append(lineCommentPin(this.count));
		if (this.showAdd) {
			const add = document.createElement('span');
			add.className = 'cm-review-plus';
			add.textContent = '+';
			number.append(add);
		}
		return number;
	}
}

function reviewNumberMarkers(): Extension {
	return [hoveredLine, reviewFocus, EditorView.focusChangeEffect.of((_state, focused) => setReviewFocus.of(focused)),
		EditorView.domEventObservers({
			pointermove(event, view) {
				if (event.pointerType === 'touch' || !(event.target instanceof Element)) return;
				const line = event.target.closest('.cm-line');
				const number = event.target.closest('.cm-lineNumbers .cm-gutterElement');
				const position = line ? view.state.doc.lineAt(view.posAtDOM(line)).from : number
					? view.lineBlockAtHeight(event.clientY - view.documentTop).from : -1;
				if (position !== view.state.field(hoveredLine)) view.dispatch({ effects: setHoveredLine.of(position) });
			},
			pointerleave(_event, view) {
				if (view.state.field(hoveredLine) !== null) view.dispatch({ effects: setHoveredLine.of(null) });
			},
		}),
		lineNumberMarkers.compute([reviewField, hoveredLine, reviewFocus, 'selection'], state => {
			const counts = state.field(reviewField).lineCounts;
			const hovered = state.field(hoveredLine);
			const active = hovered ?? (state.field(reviewFocus) ? state.doc.lineAt(state.selection.main.head).from : -1);
			const lines = new Set(counts.keys());
			if (active >= 0) lines.add(active);
			return RangeSet.of([...lines].map(position => new ReviewLineNumber(state.doc.lineAt(position).number,
				counts.get(position) ?? 0, position === active).range(position)), true);
		})];
}

class ReviewWidget extends WidgetType {
	private component?: ReturnType<typeof mount>;
	constructor(readonly row: CodeComment, readonly session: CodeReviewSession, readonly editing: boolean) { super(); }
	eq(other: ReviewWidget) { return this.row === other.row && this.editing === other.editing; }
	toDOM(): HTMLElement {
		const element = document.createElement('div');
		element.className = 'cm-line-review-widget';
		if (this.editing) element.dataset.codeReviewInline = '';
		this.component = this.editing ? mount(LineReviewCard, { target: element, props: { session: this.session, commentId: this.row.id } })
			: mount(SavedLineComment, { target: element, props: { session: this.session, comment: this.row } });
		return element;
	}
	destroy() { if (this.component) void unmount(this.component); }
	get estimatedHeight() { return this.editing ? 220 : 100; }
}

/** CM only renders a viewport. In unified mode a removed line lives in a merge widget, not the edited document. */
function deletedLineActions(target: LineReviewTarget): Extension {
	return ViewPlugin.fromClass(class {
		readonly observer: MutationObserver;
		constructor(readonly view: EditorView) {
			this.observer = new MutationObserver(() => this.render());
			this.observer.observe(view.dom, { childList: true, subtree: true });
			queueMicrotask(() => { if (view.dom.isConnected) this.render(); });
		}
		update(update: ViewUpdate) {
			if (update.startState.field(reviewField).deletedCounts !== update.state.field(reviewField).deletedCounts)
				queueMicrotask(() => { if (this.view.dom.isConnected) this.render(); });
		}
		render() {
			const { view } = this, chunks = getChunks(view.state)?.chunks;
			if (!chunks) return;
			const doc = getOriginalDoc(view.state), counts = view.state.field(reviewField).deletedCounts;
			for (const block of view.dom.querySelectorAll<HTMLElement>('.cm-deletedChunk')) {
				if (!block.hasAttribute('data-review-deleted')) {
					const position = view.posAtDOM(block);
					const chunk = chunks.find(row => row.fromB === position && row.fromA < row.toA);
					if (!chunk) continue;
					block.dataset.reviewDeleted = '';
					const start = doc.lineAt(chunk.fromA).number;
					for (const [index, row] of [...block.querySelectorAll<HTMLElement>('.cm-deletedLine')].entries()) {
						const line = start + index;
						const number = document.createElement('button');
						number.type = 'button';
						number.tabIndex = -1;
						number.className = 'cm-review-deleted-number';
						number.dataset.reviewDeletedLine = String(line);
						number.setAttribute('aria-label', `Comment on before line ${line}`);
						number.textContent = String(line);
						const add = document.createElement('span');
						add.className = 'cm-review-plus';
						add.textContent = '+';
						number.append(add);
						number.onmousedown = event => event.preventDefault();
						number.onclick = event => { event.stopPropagation(); startLineReview(view, target, 'before', line, true); };
						row.prepend(number);
					}
				}
				for (const number of block.querySelectorAll<HTMLElement>('[data-review-deleted-line]')) {
					const count = counts.get(Number(number.dataset.reviewDeletedLine)) ?? 0;
					const pin = number.querySelector('.cm-review-pin');
					if (pin && pin.textContent !== String(count)) pin.remove();
					if (count && !number.querySelector('.cm-review-pin')) number.append(lineCommentPin(count));
				}
			}
		}
		destroy() { this.observer.disconnect(); }
	});
}

export function lineReviewExtensions(target: LineReviewTarget, side: CodeSide, unified = false): Extension {
	return [reviewField,
		...(!target.disabledSides?.includes(side) ? [reviewNumberMarkers(), keymap.of([{ key: 'Alt-c', run: view => commentOnCode(view, target, side) }])] : []),
		...(unified ? [deletedLineActions(target)] : []),
		EditorView.theme({
			'.cm-line-review-widget': { boxSizing: 'border-box', width: 'min(100%, 34rem)', margin: '6px 0 6px auto', padding: '0 6px 0 3px', whiteSpace: 'normal' },
			'.cm-gutter.cm-lineNumbers': { overflow: 'visible' },
			'.cm-lineNumbers .cm-gutterElement': { cursor: 'pointer' },
			'.cm-review-line-number': { position: 'relative' },
			'.cm-review-plus': { position: 'absolute', inset: '0 -2px 0 -2px', borderRadius: '4px', textAlign: 'center',
				color: 'var(--accent-2)', background: 'var(--chat-surface-2)', fontFamily: 'var(--font-sans)', fontWeight: '700', pointerEvents: 'none' },
			'.cm-review-pin': { position: 'absolute', zIndex: '1', insetInlineEnd: '-9px', top: '-2px', minWidth: '10px', padding: '0 2px',
				borderRadius: '8px', font: '700 9px/11px var(--font-sans)', textAlign: 'center', color: 'var(--tone-primary-fg)', background: 'var(--tone-primary)', pointerEvents: 'none' },
			'.cm-deletedLine:has(.cm-review-deleted-number)': { position: 'relative' },
			'.cm-review-deleted-number': { position: 'absolute', insetInlineEnd: 'calc(100% + 1.4ch + 8px)', top: '0', minWidth: '2.4ch', height: '21px', zIndex: '201',
				font: 'inherit', color: 'var(--chat-fg-muted) !important', cursor: 'pointer' },
			'.cm-review-deleted-number .cm-review-plus': { display: 'none' },
			'@media (hover: hover)': { '.cm-deletedLine:hover .cm-review-deleted-number .cm-review-plus, .cm-review-deleted-number:focus-visible .cm-review-plus': { display: 'block' } },
			'@media (hover: none)': { '.cm-review-plus': { display: 'none' } },
		}),
	];
}

export function reviewLineNumbers(target: LineReviewTarget, side: CodeSide) {
	return { domEventHandlers: { click(view: EditorView, line: BlockInfo) {
		return !target.disabledSides?.includes(side) && startLineReview(view, target, side, view.state.doc.lineAt(line.from).number);
	} } };
}

export function drawLineReview(view: EditorView, target: LineReviewTarget, side: CodeSide, phone: boolean, unified = false): void {
	const { session, path, source } = target;
	const rows = session.comments.filter(row => row.id !== session.editor?.id).map(row => ({ row, editing: false }));
	if (session.editor && !phone) rows.push({ row: session.editor, editing: true });
	const chunks = unified ? getChunks(view.state)?.chunks : undefined;
	const after = view.state.doc;
	const lineCounts = new Map<number, number>(), deletedCounts = new Map<number, number>();
	const count = (counts: Map<number, number>, line: number) => counts.set(line, (counts.get(line) ?? 0) + 1);
	const ranges = rows.flatMap(({ row, editing }) => {
		if (row.outdated || row.anchor.path !== path || !sameReviewSource(row.source, source)) return [];
		let position: number;
		if (row.anchor.side === side) {
			if (row.anchor.endLine > after.lines) return [];
			position = after.line(row.anchor.endLine).to;
			if (!editing) count(lineCounts, after.line(row.anchor.endLine).from);
		} else if (unified && row.anchor.side === 'before' && chunks) {
			const original = getOriginalDoc(view.state);
			if (row.anchor.endLine > original.lines) return [];
			const at = original.line(row.anchor.endLine).from;
			const chunk = chunks.find(row => at >= row.fromA && at < row.toA);
			if (!chunk) return [];
			position = Math.min(chunk.endB, after.length);
			if (!editing) count(deletedCounts, row.anchor.endLine);
		} else return [];
		return [Decoration.widget({ widget: new ReviewWidget(row, session, editing), side: 1, block: true }).range(position)];
	});
	view.dispatch({ effects: reviewWidgets.of({ widgets: Decoration.set(ranges, true), lineCounts, deletedCounts }) });
}
