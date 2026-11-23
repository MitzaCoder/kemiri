<script lang="ts">
	import { untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { Portal } from 'bits-ui';
	import { notificationUrl } from '@kemiri/client';
	import { alertRowId, alertSourceLabel } from '#lib/alerts.js';
	import { alerts, type AlertPopup } from '#lib/alerts.svelte.js';
	import { harness } from '#lib/harness.svelte.js';
	import AlertCard from './AlertCard.svelte';

	const phone = new MediaQuery('(width < 640px)');
	const chatBannerHost = $derived(phone.current && !alerts.taskSheet ? alerts.chatBannerHost : undefined);
	const popupHost = $derived(alerts.taskSheet ?? chatBannerHost);
	const connectedBackends = $derived(harness.backends.filter(backend => backend.ready).length);
	let pageIndex = $state(0);
	let region = $state<HTMLElement>();
	let restoreFocus: HTMLElement | undefined;
	const sorted = $derived([...alerts.popups].sort((a, b) => Number(a.folded) - Number(b.folded) ||
		Number(b.level === 'urgent') - Number(a.level === 'urgent') || b.sortAt - a.sortAt || Number(b.id) - Number(a.id)));
	const pageSize = $derived(phone.current ? 1 : 3);
	const latest = $derived(sorted.filter(popup => !popup.folded).slice(0, pageSize));
	const queued = $derived(sorted.slice(latest.length));
	const lastPage = $derived(Math.ceil(queued.length / pageSize));
	const displayPage = $derived(phone.current ? Math.min(lastPage, pageIndex) : 0);
	const cards = $derived(!alerts.visible || alerts.inboxOpen ? [] : displayPage === 0 ? latest : queued.slice((displayPage - 1) * pageSize, displayPage * pageSize));
	const phonePosition = $derived(Math.max(1, sorted.indexOf(cards[0]!) + 1));
	// Only real slots count toward display time; acknowledge after the DOM has had a frame to paint.
	const paintedMembers = $derived(JSON.stringify(cards.map(popup => [popup.id, popup.members.map(({ row }) => alertRowId(row))])));
	$effect(() => {
		void paintedMembers;
		const host = region;
		const ids = host ? untrack(() => cards.map(popup => popup.id)) : [];
		untrack(() => alerts.setDisplayed(ids));
		let paint = 0;
		const frame = requestAnimationFrame(() => { paint = requestAnimationFrame(() => alerts.markDisplayed(ids)); });
		return () => { cancelAnimationFrame(frame); cancelAnimationFrame(paint); };
	});
	$effect(() => { if (!phone.current) pageIndex = 0; else if (pageIndex > lastPage) pageIndex = lastPage; });

	function popupSource(popup: AlertPopup): { projectName: string; sourceLabel: string } {
		const { row } = popup.members[0]!;
		const backend = harness.backend(row.backendId);
		const projectName = backend?.projects.find(project => project.id === row.alert.projectId)?.name;
		return {
			projectName: projectName || backend?.name || 'Kemiri',
			sourceLabel: alertSourceLabel(projectName, backend?.name, connectedBackends),
		};
	}

	function popupHref(popup: AlertPopup): string | undefined {
		const { row } = popup.members[0]!;
		return popup.kind !== 'alert' ? undefined : notificationUrl({ ...row.alert, backendKey: row.backendId });
	}

	function openPopup(event: MouseEvent, popup: AlertPopup): void {
		if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
		if (popup.kind !== 'alert') {
			alerts.hidePopup(popup);
			alerts.showInbox();
		} else alerts.open(popup);
	}

	function handleKeys(event: KeyboardEvent): void {
		if (event.defaultPrevented) return;
		if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === 'KeyN' && !event.repeat) {
			const newest = [...cards].sort((a, b) => b.sortAt - a.sortAt)[0];
			const action = newest && region?.querySelector<HTMLElement>(`[data-alert-card="${newest.id}"] [data-alert-open]`);
			if (!action) return;
			event.preventDefault();
			const previous = document.activeElement;
			if (previous instanceof HTMLElement && !region?.contains(previous)) restoreFocus = previous;
			const first = action.closest('[data-alert-card]')?.querySelector<HTMLElement>('button:not(:disabled), a[href]');
			(first ?? action).focus();
		}
		if (event.key !== 'Escape' || !(event.target instanceof Element) || !region?.contains(event.target)) return;
		const id = event.target.closest('[data-alert-card]')?.getAttribute('data-alert-card');
		const popup = cards.find(card => card.id === id);
		if (!popup) return;
		event.preventDefault();
		event.stopPropagation();
		alerts.dismiss(popup);
		if (restoreFocus?.isConnected) restoreFocus.focus();
		restoreFocus = undefined;
	}

	function advancePage(): void {
		pageIndex = displayPage === lastPage ? 0 : displayPage + 1;
		if (pageIndex === 0 && !latest.length && lastPage) pageIndex = 1;
	}
</script>

<svelte:window onkeydowncapture={handleKeys} />

{#if alerts.visible && !alerts.inboxOpen && sorted.length}
	<Portal to={popupHost} disabled={!popupHost}>
		<section class="alert-stack" class:under-chat-app-bar={chatBannerHost !== undefined} aria-label="Notifications" bind:this={region}
			style:--alert-composer-height="{alerts.taskSheet ? alerts.taskComposerHeight : alerts.composerHeight}px">
			{#if queued.length && (!phone.current || !cards.length)}
				<button type="button" class="alert-overflow" onclick={(event) => alerts.showInbox(event.currentTarget)}
					aria-label={`Open inbox (${queued.length} more notifications)`}>
					+{queued.length} more
				</button>
			{/if}
			{#each cards as popup (popup.id)}
				<AlertCard {popup} {...popupSource(popup)} href={popupHref(popup)} onopen={(event) => openPopup(event, popup)}
					pager={phone.current && queued.length ? { position: phonePosition, total: sorted.length, onnext: advancePage } : undefined} />
			{/each}
		</section>
	</Portal>
{/if}

<style>
	.alert-stack {
		position: fixed; z-index: 45;
		inset-inline-end: max(1rem, env(safe-area-inset-right));
		inset-block-end: calc(max(0.75rem, env(safe-area-inset-bottom)) + var(--alert-composer-height));
		width: min(20rem, calc(100% - 2rem));
		max-height: max(6rem, calc(100dvh - 2rem - var(--alert-composer-height)));
		display: flex; flex-direction: column; justify-content: flex-start; gap: 0.45rem;
		padding: 0.2rem;
		pointer-events: none;
	}
	.alert-overflow {
		align-self: end; pointer-events: auto; min-height: 1.8rem; padding-inline: 0.75rem;
		border: 1px solid var(--chat-border-strong); border-radius: 1.2rem;
		background: var(--chat-surface); color: var(--chat-fg); font-size: 0.75rem; font-weight: 650; cursor: pointer;
	}
	.alert-overflow:hover { background: var(--chat-surface-2); }
	@media (width < 640px), (pointer: coarse) { .alert-overflow { min-height: 44px; min-width: 44px; } }
	@media (width < 640px) {
		.alert-stack {
			inset: calc(max(0.5rem, env(safe-area-inset-top)) + 3rem + 0.25rem) max(0.5rem, env(safe-area-inset-right)) auto max(0.5rem, env(safe-area-inset-left));
			width: auto;
			max-height: none;
		}
		.under-chat-app-bar { position: relative; inset: auto; padding-inline: 0; }
	}
</style>
