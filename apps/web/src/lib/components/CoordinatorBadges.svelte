<script lang="ts">
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Pause from '@lucide/svelte/icons/pause';
	import type { ThreadSummary } from '@kemiri/protocol';
	import { coordinatorBadges } from '#lib/coordinators.js';
	let { thread, seen = null }: { thread: ThreadSummary; seen?: string | null } = $props();
	const badges = $derived(coordinatorBadges(thread, seen));
</script>
<span class="inline-flex shrink-0 items-center gap-1.5">
	{#if badges.needsYou}<span class="rounded-full bg-(--chat-warning)/15 px-1.5 text-[.65rem] font-semibold text-(--chat-warning)" title="{badges.needsYou} need attention"><span class="sr-only">Needs attention: </span>{badges.needsYou}</span>{/if}
	{#if badges.working}<span title="Working"><LoaderCircle class="size-3 motion-safe:animate-spin text-(--accent-2)" aria-label="Working" /></span>{/if}
	{#if badges.unread}<span title="Unread reply" aria-label="Unread reply" role="img" class="size-1.5 rounded-full bg-(--accent-2)"></span>{/if}
	{#if badges.paused}<span title="Paused"><Pause class="size-3 text-(--chat-fg-muted)" aria-label="Paused" /></span>{/if}
</span>
