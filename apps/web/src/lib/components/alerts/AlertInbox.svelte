<script lang="ts">
	import XIcon from '@lucide/svelte/icons/x';
	import CheckIcon from '@lucide/svelte/icons/check';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import DoNotDisturbMenu from './DoNotDisturbMenu.svelte';
	import { notificationUrl } from '@kemiri/client';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { alerts } from '#lib/alerts.svelte.js';
	import type { AlertRow } from '#lib/alerts.js';
	import { harness } from '#lib/harness.svelte.js';
	import { INBOX_FILTERS, inboxCoordinatorLabel, inboxDayGroups, inboxHeadline, inboxItemId, inboxUnreadCount, latestInboxRows, type InboxFilter } from '#lib/alert-inbox.js';
	import { relativeTime } from '#lib/relative-time.js';

	let filter = $state<InboxFilter>('all');
	let now = $state(Date.now());
	let navigating = false;
	let inboxPanel = $state<HTMLElement | null>(null);
	const latest = $derived(latestInboxRows(alerts.rows));
	const unread = $derived(inboxUnreadCount(latest));
	const groups = $derived(inboxDayGroups(latest, filter, now));

	$effect(() => {
		if (!alerts.inboxOpen) return;
		navigating = false;
		filter = 'all';
		now = Date.now();
		const clock = setInterval(() => { now = Date.now(); }, 30_000);
		return () => clearInterval(clock);
	});

	function source(row: AlertRow): string {
		const backend = harness.backend(row.backendId);
		const project = backend?.projects.find(project => project.id === row.alert.projectId);
		return [project?.name, backend?.name, inboxCoordinatorLabel(row.alert, project?.name), relativeTime(row.alert.at, now).replace(/ ago$/, '')]
			.filter(Boolean).join(' · ');
	}

	function openRow(event: MouseEvent, row: AlertRow): void {
		alerts.markRead(row);
		if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
		navigating = true;
		alerts.inboxOpen = false;
	}

	function restoreTrigger(event: Event): void {
		event.preventDefault();
		const trigger = alerts.inboxTrigger;
		alerts.inboxTrigger = undefined;
		if (!navigating && trigger?.isConnected) trigger.focus();
	}
</script>

<Dialog.Root open={alerts.inboxOpen} onOpenChange={(open) => { alerts.inboxOpen = open; }}>
	<Dialog.Content bind:ref={inboxPanel} showCloseButton={false} onCloseAutoFocus={restoreTrigger} overlayClass="z-[60]"
		class="inset-y-0 right-0 left-auto z-[61] flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:max-w-[28rem]">
		<div class="inbox-header">
			<div class="inbox-heading">
				<Dialog.Title>Inbox</Dialog.Title>
				<Dialog.Description class="sr-only">Recent notifications from every connected backend.</Dialog.Description>
				<Button variant="ghost" size="sm" class="ml-auto min-h-11 text-(--chat-fg-muted)" disabled={!unread}
					onclick={() => alerts.markAllRead()}>Mark all read</Button>
				<DoNotDisturbMenu inInbox portal={inboxPanel} />
				<Dialog.Close class="inbox-close" aria-label="Close inbox"><XIcon size={18} aria-hidden="true" /></Dialog.Close>
			</div>
			<div class="inbox-filters" role="group" aria-label="Filter notifications">
				{#each INBOX_FILTERS as option (option.id)}
					<button type="button" aria-pressed={filter === option.id} onclick={() => { filter = option.id; }}><span>{option.label}</span></button>
				{/each}
			</div>
		</div>
		<div class="inbox-history">
			{#each groups as group (group.day)}
				<section aria-label={group.day}>
					<h3>{group.day}</h3>
					<ul>
						{#each group.rows as row (inboxItemId(row))}
							<li>
								<a class="inbox-row" class:unread={!row.read} href={notificationUrl({ ...row.alert, backendKey: row.backendId })}
									onclick={(event) => openRow(event, row)}>
									<span class="inbox-read-dot" aria-hidden="true"></span>
									<span class="inbox-row-text">
										{#if !row.read}<span class="sr-only">Unread: </span>{/if}
										<strong>{inboxHeadline(row.alert)}</strong>
										<small>{source(row)}</small>
									</span>
									{#if row.done}<span class="inbox-row-done">Done <CheckIcon size={13} aria-hidden="true" /></span>
									{:else}<span class="inbox-row-open" aria-hidden="true">Open</span>{/if}
								</a>
							</li>
						{/each}
					</ul>
				</section>
			{:else}
				<div class="inbox-empty">
					<InboxIcon size={23} aria-hidden="true" />
					<strong>{filter === 'all' ? 'No notifications yet' : 'No matching notifications'}</strong>
					<span>{filter === 'all' ? 'Alerts from connected backends will appear here for seven days.' : 'Choose All to see the full inbox.'}</span>
				</div>
			{/each}
		</div>
	</Dialog.Content>
</Dialog.Root>

<style>
	.inbox-header { flex: none; padding: max(0.5rem, env(safe-area-inset-top)) 0.85rem 0; border-bottom: 1px solid var(--chat-border); }
	.inbox-heading { display: flex; align-items: center; gap: 0.25rem; }
	.inbox-heading :global(h2) { padding-inline-start: 0.4rem; font-weight: 700; font-size: 1.15rem; }
	.inbox-heading :global(.inbox-close) { display: grid; place-items: center; flex: none; width: 44px; height: 44px; border-radius: 0.5rem; color: var(--chat-fg-muted); cursor: pointer; }
	.inbox-heading :global(.inbox-close:hover) { background: var(--chat-surface-2); }
	.inbox-filters { display: flex; flex-wrap: wrap; gap: 0.3rem; padding-inline-start: 0.35rem; }
	.inbox-filters button { min-height: 44px; min-width: 44px; color: var(--chat-fg-muted); cursor: pointer; font-size: 0.75rem; font-weight: 650; }
	.inbox-filters span { display: block; padding: 0.28rem 0.58rem; border: 1px solid transparent; border-radius: 100vw; }
	.inbox-filters button[aria-pressed="true"] span { border-color: var(--chat-border-strong); background: var(--chat-surface-2); color: var(--chat-fg); }
	.inbox-filters button:hover span { background: var(--chat-surface-2); }
	.inbox-history { min-height: 0; flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 0.7rem 0.85rem max(0.85rem, env(safe-area-inset-bottom)); }
	h3 { padding: 0.85rem 0.65rem 0.3rem; color: var(--chat-fg-muted); font-size: 0.72rem; font-weight: 650; }
	.inbox-row { display: flex; align-items: center; gap: 0.55rem; min-height: 3.4rem; padding: 0.55rem 0.65rem; border-radius: 0.65rem; }
	.inbox-row:hover { background: var(--chat-surface-2); }
	.inbox-row:focus-visible, button:focus-visible { outline: 2px solid var(--accent-2); outline-offset: -2px; }
	.inbox-read-dot { width: 0.42rem; height: 0.42rem; flex: none; border-radius: 50%; }
	.unread .inbox-read-dot { background: var(--accent-2); }
	.inbox-row-text { min-width: 0; flex: 1; }
	.inbox-row-text strong { display: block; color: var(--chat-fg); font-size: 0.83rem; line-height: 1.35; font-weight: 520; overflow-wrap: anywhere; }
	.unread strong { font-weight: 680; }
	.inbox-row-text small { display: block; margin-top: 0.18rem; color: var(--chat-fg-muted); font-size: 0.72rem; line-height: 1.3; overflow-wrap: anywhere; }
	.inbox-row-done, .inbox-row-open { display: inline-flex; align-items: center; gap: 0.22rem; flex: none; color: var(--chat-fg-muted); font-size: 0.72rem; }
	.inbox-row-done :global(svg) { color: var(--chat-success); }
	.inbox-empty { display: grid; justify-items: center; gap: 0.45rem; margin: 2.5rem auto; text-align: center; color: var(--chat-fg-muted); }
	.inbox-empty strong { color: var(--chat-fg); font-size: 0.88rem; }
	.inbox-empty span { font-size: 0.8rem; }
</style>
