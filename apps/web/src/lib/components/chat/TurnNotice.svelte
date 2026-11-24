<script lang="ts">
	import { overlayScroll } from '#lib/scrollbars.js';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import InfoIcon from '@lucide/svelte/icons/info';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { TranscriptItem } from '#lib/transcript.js';

	/** A line in the transcript that is not a message: a reset, a retry, a failure. */
	let {
		item
	}: {
		item: Extract<TranscriptItem, { kind: 'notice' }>;
	} = $props();

	let now = $state(Date.now());
	$effect(() => {
		if (item.retryAt === undefined) return;
		now = Date.now();
		const timer = setInterval(() => { now = Date.now(); }, 1000);
		return () => clearInterval(timer);
	});
	const seconds = $derived(Math.max(0, Math.ceil(((item.retryAt ?? now) - now) / 1000)));
	const Icon = $derived(
		item.tone === 'error' ? CircleAlertIcon : item.tone === 'warning' ? TriangleAlertIcon : InfoIcon
	);
</script>

<div
	class="flex animate-rise items-start gap-2 rounded-2xl border px-3.5 py-2.5 text-sm {item.tone === 'error'
		? 'border-(--chat-danger)/30 bg-(--chat-danger)/8 text-(--chat-danger)'
		: item.tone === 'warning'
			? 'border-(--chat-warning)/30 bg-(--chat-warning)/8 text-(--chat-warning)'
			: 'border-(--chat-border) bg-(--chat-surface)/60 text-(--chat-fg-muted)'}"
>
	<Icon class="mt-0.5 size-4 shrink-0" />
	<div class="min-w-0">
		<p class="break-words">{item.text}</p>
		{#if item.tries !== undefined}
			<p class="mt-0.5">{seconds > 0 ? `Retrying in ${seconds} s` : 'Trying again'} ({item.tries} {item.tries === 1 ? 'try' : 'tries'} so far).</p>
		{/if}
		{#if item.detail}
			<details class="mt-1 text-xs">
				<summary class="w-fit cursor-pointer underline underline-offset-2">Details</summary>
				<div class="relative">
					<pre use:overlayScroll={'parent'} class="mt-1 overflow-auto font-mono break-words whitespace-pre-wrap opacity-80">{item.detail}</pre>
				</div>
			</details>
		{/if}
	</div>
</div>
