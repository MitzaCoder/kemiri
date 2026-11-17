<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import type { WorkerSummary } from '@kemiri/protocol';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import type { GraphPosition } from '#lib/task-graph.js';
	import { GRAPH_PEEK_HOVER_MS, GRAPH_PEEK_LEAVE_MS, graphPeekDragged, graphPeekTaskId, graphPeekUsesSheet, placeGraphPeek } from '#lib/graph-peek.js';
	import TaskPeek from '../TaskPeek.svelte';

	let { stage, board, workers, taskHref, viewBox, positions, visibleTaskIds, onTaskChange, onShowLinked, onWorker }: {
		stage: HTMLDivElement | null;
		board: ProjectBoard | undefined;
		workers: readonly WorkerSummary[];
		taskHref: (taskId: string) => string;
		viewBox: string;
		positions: ReadonlyMap<string, GraphPosition>;
		visibleTaskIds: ReadonlySet<string>;
		onTaskChange: (taskId: string | null) => void;
		onShowLinked: (taskId: string) => void;
		/** T258 can replace selection/panning at this boundary with the worker pop-up. */
		onWorker: (workerId: string) => void;
	} = $props();

	type Anchor = HTMLElement | SVGElement;
	type Shown = { taskId: string; anchor: Anchor; via: 'hover' | 'focus' | 'tap' };
	const componentId = $props.id();
	const cardId = `graph-task-peek-${componentId}`;
	const tabbableSelector = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
	let shown = $state<Shown | null>(null);
	let card = $state<HTMLDivElement | null>(null);
	let place = $state({ left: 0, top: 0, width: 360, maxHeight: 0, ready: false });
	let openTimer: ReturnType<typeof setTimeout> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	let pending: Anchor | null = null;
	let refocusing = false;
	let frame = 0;
	let lastPointer = { type: '', at: 0 };
	let gesture: { x: number; y: number; moved: boolean } | null = null;
	const pointers = new Set<number>();
	const task = $derived(shown && visibleTaskIds.has(shown.taskId) ? board?.task(shown.taskId) : undefined);

	function anchorOf(target: EventTarget | null): Anchor | null {
		if (!(target instanceof Element)) return null;
		const anchor = target.closest<Anchor>('[data-node]');
		return anchor && stage?.contains(anchor) && graphPeekTaskId(anchor.getAttribute('data-node')) ? anchor : null;
	}
	function inCard(target: EventTarget | null): boolean { return target instanceof Node && !!card?.contains(target); }
	function inAnchor(target: EventTarget | null): boolean { return target instanceof Node && !!shown?.anchor.contains(target); }
	function clearOpen() { clearTimeout(openTimer); openTimer = undefined; pending = null; }
	function clearClose() { clearTimeout(closeTimer); closeTimer = undefined; }
	function close(restoreFocus = false) {
		clearOpen(); clearClose();
		if (!shown) return;
		const anchor = shown.anchor;
		anchor.removeAttribute('aria-expanded'); anchor.removeAttribute('aria-controls');
		shown = null;
		onTaskChange(null);
		if (restoreFocus && anchor.isConnected) {
			refocusing = true; anchor.focus({ preventScroll: true }); refocusing = false;
		}
	}
	async function show(anchor: Anchor, via: Shown['via']) {
		const taskId = graphPeekTaskId(anchor.getAttribute('data-node'));
		if (!taskId || !board?.task(taskId)) return;
		clearOpen(); clearClose();
		if (shown?.anchor === anchor) return;
		close();
		place = { ...place, ready: false };
		shown = { taskId, anchor, via };
		anchor.setAttribute('aria-expanded', 'true'); anchor.setAttribute('aria-controls', cardId);
		onTaskChange(taskId);
		await tick();
		requestReposition();
		if (via === 'tap') tabbables(card)[0]?.focus();
	}
	function scheduleOpen(anchor: Anchor) {
		clearClose();
		if (shown?.anchor === anchor || pending === anchor) return;
		clearOpen(); pending = anchor;
		openTimer = setTimeout(() => { if (anchor.isConnected) void show(anchor, 'hover'); }, GRAPH_PEEK_HOVER_MS);
	}
	function scheduleClose() { clearClose(); closeTimer = setTimeout(() => close(), GRAPH_PEEK_LEAVE_MS); }
	function tabbables(root: ParentNode | null): Anchor[] {
		return root ? [...root.querySelectorAll<Anchor>(tabbableSelector)].filter(element => element.getClientRects().length > 0) : [];
	}
	function reposition() {
		frame = 0;
		if (!shown || !stage || !card) return;
		if (!shown.anchor.isConnected) return close();
		const target = placeGraphPeek(shown.anchor.getBoundingClientRect(), stage.getBoundingClientRect(), card.getBoundingClientRect(), { width: innerWidth, height: innerHeight });
		if (target.outside || !task) return close();
		place = { ...target, ready: true };
	}
	function requestReposition() { if (!frame) frame = requestAnimationFrame(reposition); }
	$effect(() => {
		void viewBox; void positions;
		if (shown && !task) { close(); return; }
		if (!shown || !card || !stage) return;
		requestReposition();
		const observer = new ResizeObserver(requestReposition);
		observer.observe(card); observer.observe(stage);
		return () => observer.disconnect();
	});
	function openTask(taskId: string) { close(); void goto(taskHref(taskId)); }

	$effect(() => {
		const root = stage;
		if (!root) return;
		const coarse = matchMedia('(hover: none), (pointer: coarse)');
		const over = (event: PointerEvent) => {
			if (graphPeekUsesSheet(event.pointerType, coarse.matches, navigator.maxTouchPoints) || event.buttons) return;
			if (inCard(event.target)) return clearClose();
			const anchor = anchorOf(event.target);
			if (anchor) scheduleOpen(anchor);
		};
		const out = (event: PointerEvent) => {
			if (event.pointerType === 'touch') return;
			const to = event.relatedTarget;
			if (pending && !(to instanceof Node && pending.contains(to))) clearOpen();
			if (shown?.via === 'hover' && (inAnchor(event.target) || inCard(event.target)) && !inAnchor(to) && !inCard(to)) scheduleClose();
		};
		const down = (event: PointerEvent) => {
			lastPointer = { type: event.pointerType, at: Date.now() };
			if (inCard(event.target)) return;
			clearOpen();
			pointers.add(event.pointerId);
			if (pointers.size === 1) gesture = { x: event.clientX, y: event.clientY, moved: false };
			else if (gesture) gesture.moved = true;
			if (shown && !inAnchor(event.target)) close();
		};
		const move = (event: PointerEvent) => {
			if (pointers.has(event.pointerId) && gesture && graphPeekDragged(gesture, { x: event.clientX, y: event.clientY })) {
				gesture.moved = true; close();
			}
		};
		const up = (event: PointerEvent) => { pointers.delete(event.pointerId); };
		const cancel = (event: PointerEvent) => { up(event); if (gesture) gesture.moved = true; close(); };
		const click = (event: MouseEvent) => {
			const anchor = anchorOf(event.target);
			if (!anchor) return;
			if (gesture?.moved && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); return; }
			const touch = graphPeekUsesSheet((event as PointerEvent).pointerType, coarse.matches, navigator.maxTouchPoints) || (lastPointer.type === 'touch' && Date.now() - lastPointer.at < 1000);
			if (touch && event.detail !== 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
				event.preventDefault(); event.stopPropagation(); void show(anchor, 'tap');
			} else close();
		};
		const focusin = (event: FocusEvent) => {
			if (inCard(event.target)) return clearClose();
			const anchor = anchorOf(event.target);
			if (!refocusing && anchor?.matches(':focus-visible') && !(lastPointer.type === 'touch' && Date.now() - lastPointer.at < 1000)) void show(anchor, 'focus');
		};
		const focusout = (event: FocusEvent) => {
			// Answering removes the focused option. Keep the live card/sheet open and give it focus back.
			if (shown && !event.relatedTarget && inCard(event.target)) {
				void tick().then(() => { if (shown && document.activeElement === document.body) tabbables(card)[0]?.focus(); });
				return;
			}
			if (shown && !inAnchor(event.relatedTarget) && !inCard(event.relatedTarget)) scheduleClose();
		};
		const keydown = (event: KeyboardEvent) => {
			if (!shown) { if (event.key === 'Escape') clearOpen(); return; }
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
			if (event.key !== 'Tab' || !card) return;
			const controls = tabbables(card), active = document.activeElement;
			if (shown.via === 'tap') {
				if (event.shiftKey && active === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
				else if (!event.shiftKey && active === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
			} else if (active === shown.anchor && !event.shiftKey) {
				event.preventDefault(); shown = { ...shown, via: 'focus' }; controls[0]?.focus();
			} else if (event.shiftKey && active === controls[0]) { event.preventDefault(); shown.anchor.focus(); }
			else if (!event.shiftKey && active === controls.at(-1)) {
				event.preventDefault();
				const anchor = shown.anchor, order = tabbables(root).filter(element => !inCard(element));
				const next = order[order.indexOf(anchor) + 1]; close(); (next ?? anchor).focus();
			}
		};
		root.addEventListener('pointerover', over, true); root.addEventListener('pointerout', out, true);
		root.addEventListener('pointerdown', down, true); root.addEventListener('pointermove', move, true);
		root.addEventListener('pointerup', up, true); root.addEventListener('pointercancel', cancel, true);
		root.addEventListener('click', click, true); root.addEventListener('focusin', focusin, true);
		root.addEventListener('focusout', focusout, true); root.addEventListener('keydown', keydown, true);
		window.addEventListener('resize', requestReposition); window.addEventListener('scroll', requestReposition, true);
		return () => {
			close(); cancelAnimationFrame(frame);
			root.removeEventListener('pointerover', over, true); root.removeEventListener('pointerout', out, true);
			root.removeEventListener('pointerdown', down, true); root.removeEventListener('pointermove', move, true);
			root.removeEventListener('pointerup', up, true); root.removeEventListener('pointercancel', cancel, true);
			root.removeEventListener('click', click, true); root.removeEventListener('focusin', focusin, true);
			root.removeEventListener('focusout', focusout, true); root.removeEventListener('keydown', keydown, true);
			window.removeEventListener('resize', requestReposition); window.removeEventListener('scroll', requestReposition, true);
		};
	});
</script>

{#if shown && task}
	{#if shown.via === 'tap'}<button class="peek-backdrop" tabindex="-1" aria-label="Close task preview" onclick={() => close(true)}></button>{/if}
	<div bind:this={card} id={cardId} class="peek-host" class:sheet={shown.via === 'tap'} role="dialog" aria-modal={shown.via === 'tap' ? true : undefined} aria-label="Task {task.id}" data-graph-task-peek
		style={shown.via === 'tap' ? '' : `left:${place.left}px;top:${place.top}px;width:${place.width}px;max-height:${place.maxHeight}px;visibility:${place.ready ? 'visible' : 'hidden'}`}>
		<button type="button" class="peek-close" aria-label="Close task preview" onclick={() => close(true)}>×</button>
		<TaskPeek {task} tasks={board?.tasks} questions={board?.board?.questions} {workers} archivedLinks={board?.archivedLinks} {taskHref}
			activityEnabled={board?.activityEnabled} freshnessEnabled={board?.freshnessEnabled} layout={shown.via === 'tap' ? 'sheet' : 'card'}
			onAnswer={board ? (question, answer) => board.answer(question.id, question.revision, answer) : undefined}
			onOpenTask={openTask} onShowLinked={taskId => { close(); onShowLinked(taskId); }} onWorker={workerId => { close(); onWorker(workerId); }} />
	</div>
{/if}

<style>
	.peek-host { position: absolute; z-index: 6; overflow: auto; overscroll-behavior: contain; border-radius: 16px; }
	.peek-close { position: absolute; z-index: 1; top: 6px; right: 6px; width: 24px; height: 24px; border-radius: 50%; background: var(--chat-surface-2); color: var(--chat-fg-muted); font-size: 18px; line-height: 1; }
	.peek-close:hover { color: var(--chat-fg); }
	.peek-close:focus-visible { outline: 2px solid var(--accent-2); outline-offset: -2px; }
	.peek-host :global(.task-peek > header) { padding-right: 22px; }
	.peek-host :global(.task-peek) { width: 100%; }
	.sheet { left: 0; right: 0; bottom: 0; width: 100%; max-height: calc(100% - 8px); border-radius: 20px 20px 0 0; }
	.peek-backdrop { position: absolute; inset: 0; z-index: 5; background: color-mix(in oklab, var(--chat-bg) 12%, transparent); }
	@media (pointer: coarse) { .peek-close { width: 44px; height: 44px; top: 0; right: 0; } .peek-host :global(.task-peek > header) { padding-right: 30px; } }
	.sheet .peek-close { top: 16px; right: 16px; }
	.sheet :global(.task-peek > header) { padding-right: 44px; min-height: 44px; }
</style>
