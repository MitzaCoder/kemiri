import { refCardAnchor } from './ref-card-anchor.js';
import { taskIdFromHref } from './task-chat.js';

/** A task mention is a self-reference only inside that task's details. */
export function isTaskSelfReference(taskId: string, openTaskId?: string): boolean {
	return taskId === openTaskId && /^T\d+$/.test(taskId);
}

/** Only paint targets already visible, including clipping by a panel's scrollport. Never scroll. */
export function taskTargetVisible(element: HTMLElement): boolean {
	if (!element.getClientRects().length) return false;
	const rect = element.getBoundingClientRect();
	let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
	let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
	for (let parent = element.parentElement; parent; parent = parent.parentElement) {
		const style = getComputedStyle(parent);
		const bounds = parent.getBoundingClientRect();
		if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
		if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
	}
	return right > left && bottom > top;
}

/** Separate from preview timing: hover/focus connects prose to visible list/board targets immediately. */
export function observeTaskReferences(): () => void {
	const root = document;
	let hovered: HTMLAnchorElement | undefined;
	let focused: HTMLAnchorElement | undefined;
	let painted: HTMLElement[] = [];
	const anchorOf = (target: EventTarget | null) => refCardAnchor(target, location.href);
	function clear() { for (const target of painted) target.classList.remove('task-reference-highlight'); painted = []; }
	function paint() {
		const anchor = hovered ?? focused;
		const id = anchor?.isConnected && taskTargetVisible(anchor) ? taskIdFromHref(anchor.href, location.href) : undefined;
		const next = id === undefined ? [] : [...root.querySelectorAll<HTMLElement>('.task-row[data-task], .task-card[data-task]')]
			.filter(target => target.dataset.task === id && taskTargetVisible(target));
		for (const target of painted) if (!next.includes(target)) target.classList.remove('task-reference-highlight');
		for (const target of next) target.classList.add('task-reference-highlight');
		painted = next;
	}
	const over = (event: PointerEvent) => { if (event.pointerType !== 'touch') { hovered = anchorOf(event.target); paint(); } };
	const out = (event: PointerEvent) => { if (event.pointerType !== 'touch') { hovered = anchorOf(event.relatedTarget); paint(); } };
	const focus = (event: FocusEvent) => { focused = anchorOf(event.target); paint(); };
	const blur = (event: FocusEvent) => { focused = anchorOf(event.relatedTarget); paint(); };
	const windowBlur = () => { hovered = focused = undefined; clear(); };
	const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { hovered = focused = undefined; clear(); } };
	root.addEventListener('pointerover', over);
	root.addEventListener('pointerout', out);
	root.addEventListener('focusin', focus);
	root.addEventListener('focusout', blur);
	window.addEventListener('keydown', escape, true);
	root.addEventListener('scroll', paint, true);
	window.addEventListener('blur', windowBlur);
	window.addEventListener('resize', paint);
	const observer = new MutationObserver(() => { if (hovered || focused) paint(); });
	observer.observe(root.body, { childList: true, subtree: true });
	return () => {
		clear();
		root.removeEventListener('pointerover', over); root.removeEventListener('pointerout', out);
		root.removeEventListener('focusin', focus); root.removeEventListener('focusout', blur);
		window.removeEventListener('keydown', escape, true); root.removeEventListener('scroll', paint, true);
		window.removeEventListener('blur', windowBlur); window.removeEventListener('resize', paint);
		observer.disconnect();
	};
}
