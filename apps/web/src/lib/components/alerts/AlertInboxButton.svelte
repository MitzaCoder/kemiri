<script lang="ts">
	import BellIcon from '@lucide/svelte/icons/bell';
	import { Button } from '#lib/components/ui/button/index.js';
	import { alerts } from '#lib/alerts.svelte.js';
	import { inboxUnreadCount, latestInboxRows } from '#lib/alert-inbox.js';

	let { class: className = '' }: { class?: string } = $props();
	const unread = $derived(inboxUnreadCount(latestInboxRows(alerts.rows)));
</script>

<Button variant="ghost" size="icon-sm" class="relative shrink-0 {className}" aria-haspopup="dialog" aria-expanded={alerts.inboxOpen}
	aria-label={unread ? `Inbox, ${unread} unread` : 'Inbox'} title="Notification inbox"
	onclick={(event) => alerts.showInbox(event.currentTarget)}>
	<BellIcon aria-hidden="true" />
	{#if unread}<span class="inbox-unread" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>{/if}
</Button>

<style>
	.inbox-unread {
		position: absolute; inset-block-start: 0; inset-inline-end: 0;
		display: grid; place-items: center; min-width: 1rem; height: 1rem; padding-inline: 0.16rem;
		pointer-events: none; border-radius: 100vw; font-size: 0.64rem; font-weight: 750; line-height: 1;
		background: var(--primary); color: var(--primary-foreground); box-shadow: 0 0 0 1px var(--chat-bg);
	}
</style>
