<script lang="ts">
	import { X, ArrowUpRight, TriangleAlert, Diamond, Circle, Check, Ellipsis } from '@lucide/svelte';
	import { isNotificationFailure } from '@kemiri/client';
	import { alertRowId, canAnswerAlert } from '#lib/alerts.js';
	import { alerts, type AlertPopup } from '#lib/alerts.svelte.js';
	import { DropdownMenu } from 'bits-ui';
	import { harness } from '#lib/harness.svelte.js';
	import { notifications } from '#lib/notifications.svelte.js';
	import { quietPeriod } from '#lib/alert-quiet.js';

	let { popup, projectName, backendName, sourceLabel, href, onopen, pager }: {
		popup: AlertPopup; projectName: string; backendName: string; sourceLabel: string; href?: string; onopen: (event: MouseEvent) => void;
		pager?: { position: number; total: number; onnext: () => void };
	} = $props();

	const row = $derived(popup.members[0]!.row);
	const alert = $derived(row.alert);
	const projectId = $derived(popup.members.every(member => member.row.alert.projectId === alert.projectId) ? alert.projectId : null);
	const menuItemClass = 'flex min-h-11 cursor-pointer items-center rounded-lg px-2.5 text-sm outline-none data-highlighted:bg-(--chat-surface-2)';
	const rowId = $derived(alertRowId(popup.members[0]!.row));
	const levelLabel = $derived({ urgent: 'Urgent', important: 'Important', info: 'Info' }[popup.level]);
	const LevelIcon = $derived({ urgent: TriangleAlert, important: Diamond, info: Circle }[popup.level]);
	const projectCount = $derived(new Set(popup.members.flatMap(({ row }) => row.alert.projectId === null ? [] : [JSON.stringify([row.backendId, row.alert.projectId])])).size);
	const missedCount = $derived(popup.members.length);
	const headline = $derived(alerts.hideText ? 'New question'
		: popup.kind === 'catch-up' ? `While you were away: ${missedCount} ${missedCount === 1 ? 'thing' : 'things'}${projectCount ? ` in ${projectCount} ${projectCount === 1 ? 'project' : 'projects'}` : ''}`
		: popup.kind === 'burst' ? `${projectName}: ${popup.members.length} new things`
		: alert.kind === 'board_question' ? alert.warning ? 'Warning' : 'Needs your answer'
		: alert.kind === 'task_review' ? 'Ready for you to check'
		: isNotificationFailure(alert.kind) ? 'Something stopped working' : alert.title);
	const body = $derived(alert.kind === 'worker_failed' && /^[a-z]+(?:_[a-z]+)+$/.test(alert.body)
		? 'A worker stopped before it could report.' : alert.body);
	const choices = $derived(!alerts.hideText && popup.kind === 'alert' && canAnswerAlert(alert) ? alert.choices : []);
	let answerState = $state<{ rowId: string; selected?: string; sending?: boolean; error?: 'changed' | 'failed' }>();
	const answer = $derived(answerState?.rowId === rowId ? answerState : undefined);
	let swipeStart: { pointer: number; x: number; y: number } | undefined;
	let swiped = false;

	async function choose(label: string) {
		if (swiped || answer?.sending || answer?.error === 'changed') return;
		if (answer?.selected !== label) { answerState = { rowId, selected: label }; return; }
		const row = popup.members[0]!.row;
		const submittedId = rowId;
		answerState = { rowId: submittedId, selected: label, sending: true };
		const result = await alerts.answer(row, label);
		if (rowId === submittedId && result !== 'answered') answerState = { rowId: submittedId, error: result };
	}

	function startSwipe(event: PointerEvent) {
		swiped = false;
		if (event.isPrimary && event.pointerType === 'touch') swipeStart = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
	}
	function finishSwipe(event: PointerEvent) {
		if (swipeStart?.pointer !== event.pointerId) return;
		const across = Math.abs(event.clientX - swipeStart.x);
		const down = Math.abs(event.clientY - swipeStart.y);
		swipeStart = undefined;
		if (across >= 55 && across > down * 1.5) {
			swiped = true;
			alerts.dismiss(popup);
		}
	}
	function open(event: MouseEvent) {
		if (swiped) event.preventDefault();
		else onopen(event);
	}
</script>

<article
	class="alert-card"
	data-alert-card={popup.id}
	data-level={popup.level}
	onpointerenter={(event) => { if (event.pointerType === 'mouse') alerts.pause(popup.id, 'hover', true); }}
	onpointerleave={() => alerts.pause(popup.id, 'hover', false)}
	onfocusin={() => alerts.pause(popup.id, 'focus', true)}
	onfocusout={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) alerts.pause(popup.id, 'focus', false); }}
	onpointerdown={startSwipe}
	onpointerup={finishSwipe}
	onpointercancel={() => { swipeStart = undefined; }}
>
	<div class="alert-header">
		<div class="alert-eyebrow">
			{#if !alerts.hideText}<span class="alert-level"><LevelIcon size={13} aria-hidden="true" />{levelLabel}</span>{/if}
			{#if popup.kind === 'alert' || alerts.hideText || (popup.kind === 'burst' && sourceLabel !== projectName)}
				<span class="alert-source" title={sourceLabel}>{sourceLabel}</span>
			{/if}
		</div>
		{#if pager}
			<button type="button" class="alert-page" aria-label={`Show next notification (${pager.position} of ${pager.total})`}
				onclick={() => { if (!swiped) pager?.onnext(); }}><span>{pager.position} of {pager.total}</span></button>
		{/if}
		<DropdownMenu.Root onOpenChange={(open) => alerts.pause(popup.id, 'menu', open)}>
			<DropdownMenu.Trigger class="alert-options" aria-label="Notification options" title="Notification options">
				<Ellipsis size={17} aria-hidden="true" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal to={alerts.taskSheet ?? undefined}>
				<DropdownMenu.Content sideOffset={6} align="end"
					class="z-[75] w-64 max-w-[calc(100vw-1rem)] rounded-xl border border-(--chat-border) bg-(--chat-surface) p-1 text-(--chat-fg) shadow-xl">
					{#if projectId !== null}
						<DropdownMenu.Item class={menuItemClass} onSelect={() => { if (projectId !== null) void notifications.setProjectMute(harness.backends, row.backendId, projectId, quietPeriod('hour', Date.now())); }}>Mute {projectName} for 1 hour</DropdownMenu.Item>
					{/if}
					<DropdownMenu.Item class={menuItemClass} onSelect={() => void notifications.setBackendMute(harness.backends, row.backendId, quietPeriod('hour', Date.now()))}>Mute {backendName} for 1 hour</DropdownMenu.Item>
					<DropdownMenu.Item class={menuItemClass} disabled={alerts.soundSetting === 'off'} onSelect={() => alerts.setSettings({ soundSetting: 'off' })}>Turn off sounds</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
		<button type="button" class="alert-dismiss" aria-label="Dismiss notification" title="Dismiss notification" onclick={() => alerts.dismiss(popup)}><X size={17} aria-hidden="true" /></button>
	</div>
	<div role={popup.level === 'urgent' ? 'alert' : 'status'}>
		{#if !alerts.hideText}<span class="sr-only">{levelLabel} · {sourceLabel}. </span>{/if}
		<p class="alert-headline">{headline}</p>
		{#if popup.kind === 'alert' && !alerts.hideText && body}<p class="alert-body">{body}</p>{/if}
	</div>
	{#if answer?.error && !alerts.hideText}
		<p class="alert-feedback" role="status">{answer.error === 'changed' ? 'This question changed' : 'Could not send the answer. Try again or open the question.'}</p>
	{/if}
	<div class="alert-actions">
		{#if choices.length && answer?.error !== 'changed'}
			{#each choices as choice (choice.label)}
				{@const selected = answer?.selected === choice.label}
				<button type="button" class="alert-choice" class:recommended={choice.recommended} aria-pressed={selected} disabled={answer?.sending}
					aria-label={selected ? `Confirm answer: ${choice.label}` : choice.recommended ? `${choice.label} (recommended)` : choice.label}
					onclick={() => choose(choice.label)}>
					{#if selected}<Check size={14} aria-hidden="true" />{/if}{choice.label}
				</button>
			{/each}
		{/if}
		{#if href}
			<a class="alert-open" data-alert-open {href} onclick={open}>Open <ArrowUpRight size={14} aria-hidden="true" /></a>
		{:else}
			<button class="alert-open" type="button" data-alert-open onclick={open}>Open <ArrowUpRight size={14} aria-hidden="true" /></button>
		{/if}
	</div>
	{#if answer?.selected && !answer.sending && !alerts.hideText}<p class="alert-confirm" role="status">Tap the choice again to send.</p>{/if}
</article>

<style>
	.alert-card {
		--alert-level: var(--chat-fg-muted);
		position: relative;
		pointer-events: auto;
		border: 1px solid var(--chat-border-strong);
		border-inline-start: 3px solid var(--alert-level);
		border-radius: 0.9rem;
		background: var(--chat-surface);
		color: var(--chat-fg);
		padding: 0.75rem;
		box-shadow: 0 8px 28px color-mix(in oklab, var(--chat-shadow) 24%, transparent);
		animation: alert-arrive 160ms ease-out both;
		touch-action: pan-y;
	}
	.alert-card[data-level="urgent"] { --alert-level: var(--chat-danger); }
	.alert-card[data-level="important"] { --alert-level: var(--chat-warning); }
	.alert-header { display: flex; align-items: center; gap: 0.3rem; margin: -0.4rem -0.4rem 0.05rem 0; }
	.alert-eyebrow { display: flex; flex: 1; align-items: center; gap: 0.5rem; min-width: 0; font-size: 0.73rem; }
	.alert-level { display: inline-flex; flex: none; align-items: center; gap: 0.25rem; font-weight: 700; }
	.alert-level :global(svg) { color: var(--alert-level); }
	.alert-source { color: var(--chat-fg-muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
	.alert-headline { font-size: 0.9rem; font-weight: 700; line-height: 1.3; overflow-wrap: anywhere; }
	.alert-body { color: var(--chat-fg-muted); font-size: 0.8rem; margin-top: 0.25rem; overflow: hidden; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
	.alert-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem; margin-top: 0.55rem; }
	.alert-choice, .alert-dismiss, .alert-open {
		display: inline-flex; align-items: center; justify-content: center; gap: 0.25rem;
		min-height: 1.8rem; padding: 0.15rem 0.45rem; border: 1px solid var(--chat-border);
		border-radius: 0.45rem; font-size: 0.76rem; font-weight: 600; cursor: pointer;
	}
	.alert-choice:hover, .alert-dismiss:hover, .alert-open:hover { background: var(--chat-surface-2); }
	.alert-choice.recommended { border-color: var(--chat-border-strong); }
	.alert-choice[aria-pressed="true"] { border-color: var(--accent-1); background: var(--chat-surface-2); }
	.alert-choice:disabled { cursor: wait; }
	.alert-open { margin-inline-start: auto; white-space: nowrap; }
	.alert-dismiss { flex: none; border-color: transparent; color: var(--chat-fg-muted); }
	.alert-header :global(.alert-options) {
		display: grid; place-items: center; flex: none; width: 1.8rem; height: 1.8rem;
		color: var(--chat-fg-muted); border-radius: 0.45rem; cursor: pointer;
	}
	.alert-header :global(.alert-options:hover) { background: var(--chat-surface-2); }
	.alert-page { flex: none; min-width: 44px; min-height: 44px; font-size: 0.73rem; font-weight: 650; cursor: pointer; }
	.alert-page span { display: block; padding: 0.15rem 0.45rem; border: 1px solid var(--chat-border-strong); border-radius: 1rem; }
	.alert-page:hover span { background: var(--chat-surface-2); }
	.alert-feedback, .alert-confirm { color: var(--chat-fg-muted); font-size: 0.73rem; margin-top: 0.35rem; }
	@keyframes alert-arrive { from { opacity: 0; transform: translateY(0.35rem); } to { opacity: 1; transform: translateY(0); } }
	@keyframes alert-fade { from { opacity: 0; } to { opacity: 1; } }
	@media (prefers-reduced-motion: reduce) { .alert-card { animation-name: alert-fade; } }
	@media (width < 640px), (pointer: coarse) {
		.alert-choice, .alert-dismiss, .alert-open, .alert-header :global(.alert-options) { min-height: 44px; min-width: 44px; }
	}
	@media (width < 640px) {
		.alert-open::after { content: ''; position: absolute; inset: 0; }
		.alert-choice, .alert-dismiss, .alert-page, .alert-header :global(.alert-options) { position: relative; z-index: 1; }
	}
</style>
