import { goto } from '$app/navigation';
import { page } from '$app/state';
import { tick, onDestroy } from 'svelte';
import type { SidebarTab } from './sidebar.js';

/** SvelteKit snapshots belong to history entries, not device defaults. Never include editor/draft values. */
export interface ConversationView {
	open: boolean;
	tab: SidebarTab;
	expanded: boolean;
	tasksMode?: import('./kanban.js').TasksViewMode;
	taskFocus?: string | null;
	scroll: { name: string; top: number; left: number; follow: boolean }[];
}
type PanelView = Omit<ConversationView, 'scroll'>;
let stopRestoring: (() => void) | undefined;
let conversation: { read: () => PanelView; restore: (view: ConversationView) => void } | undefined;

export function rememberConversationView(read: () => PanelView, restore: (view: ConversationView) => void): void {
	const registered = { read, restore };
	conversation = registered;
	onDestroy(() => { if (conversation === registered) conversation = undefined; });
}

/** Export this on every coordinator, thread and worker page. The router captures before leaving and restores on pop. */
export const conversationSnapshot = {
	capture(): ConversationView | undefined {
		stopRestoring?.();
		if (!conversation) return undefined;
		return { ...conversation.read(), scroll: [...document.querySelectorAll<HTMLElement>('[data-navigation-scroll]')].map(element => ({ name: element.dataset.navigationScroll!, top: element.scrollTop, left: element.scrollLeft, follow: element.scrollHeight - element.scrollTop - element.clientHeight < 80 })) };
	},
	restore(saved: ConversationView | undefined): void {
		stopRestoring?.();
		if (!saved) return;
		conversation?.restore(saved);
		const pending = new Map(saved.scroll.map(position => [position.name, position]));
		const notified = new Set<string>();
		const apply = () => {
			for (const element of document.querySelectorAll<HTMLElement>('[data-navigation-scroll]')) {
				const position = pending.get(element.dataset.navigationScroll!);
				if (!position) continue;
				if (!notified.has(position.name)) {
					element.dispatchEvent(new CustomEvent('conversation-scroll-restore', { detail: position }));
					notified.add(position.name);
				}
				if (element.scrollHeight < position.top + element.clientHeight || (position.name === 'transcript' && !element.querySelector('[data-transcript-key]'))) continue;
				element.scrollTo({ top: position.top, left: position.left, behavior: 'instant' });
				pending.delete(position.name);
			}
		};
		void tick().then(() => {
			apply();
			if (!pending.size) return;
			const stop = () => {
				observer.disconnect();
				clearTimeout(timeout);
				for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.removeEventListener(event, stop);
				if (stopRestoring === stop) stopRestoring = undefined;
			};
			const observer = new MutationObserver(() => { apply(); if (!pending.size) stop(); });
			const timeout = setTimeout(stop, 8000);
			stopRestoring = stop;
			for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) window.addEventListener(event, stop, { passive: true });
			observer.observe(document.body, { childList: true, subtree: true });
		});
	}
};

/** A real return, not a new coordinator/thread entry that discards the launch context. */
export function conversationBack(event: MouseEvent, fallback: string): void {
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	event.preventDefault();
	if ((page.state.navigation?.index ?? 0) > 0) history.back();
	else void goto(fallback, { replace: true });
}
