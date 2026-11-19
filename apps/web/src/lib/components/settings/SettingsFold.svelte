<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import type { Snippet } from 'svelte';

	let { title, children }: { title: string; children: Snippet } = $props();
</script>

<details class="group/settings-fold min-w-0">
	<summary class="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-4 text-sm font-semibold outline-none hover:bg-(--chat-surface-2)/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5 [&::-webkit-details-marker]:hidden">
		<ChevronRightIcon class="size-4 shrink-0 text-muted-foreground group-open/settings-fold:rotate-90" aria-hidden="true" />
		{title}
	</summary>
	<div class="divide-y divide-(--chat-border)">{@render children()}</div>
</details>
