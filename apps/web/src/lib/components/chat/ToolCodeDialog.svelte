<script lang="ts">
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { loadCodeViewer } from '#lib/code/load-viewer.js';
	import { fitsCodeView } from '#lib/code/limits.js';
	import CopyButton from '#lib/components/CopyButton.svelte';

	let { open = $bindable(false), path, text, isDiff, notice }: {
		open?: boolean; path: string; text: string; isDiff: boolean; notice?: string;
	} = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex h-dvh max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[90dvh] sm:w-[min(85vw,100rem)] sm:max-w-none sm:rounded-lg">
		<header class="shrink-0 border-b border-(--chat-border) px-4 py-3 pr-12">
			<Dialog.Title class="truncate text-base font-semibold">{path}</Dialog.Title>
			<Dialog.Description class="text-xs text-(--chat-fg-muted)">{isDiff ? 'Recorded edit · omitted lines are not available' : 'Text recorded in this tool card'}{notice ? ` · ${notice}` : ''}</Dialog.Description>
		</header>
		{#if open}
			{#if fitsCodeView(text)}
				{#await loadCodeViewer()}
					<p class="p-4 text-sm" role="status">Opening full view…</p>
				{:then { default: CodeViewer }}
					<div class="min-h-0 min-w-0 flex-1"><CodeViewer {path} {text} languageHint={isDiff ? 'diff' : undefined} roomy /></div>
				{:catch}
					<p class="p-4 text-sm" role="status">Could not open the viewer. Showing plain text.</p>
					{@render plainText()}
				{/await}
			{:else}
				<p class="p-4 text-sm" role="status">This card exceeds the viewer limits. Showing plain text.</p>
				{@render plainText()}
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>

{#snippet plainText()}
	<div class="self-end px-3"><CopyButton {text} label="Copy text" /></div>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (the scrollable preview needs keyboard focus) -->
	<pre class="flex-1 overflow-auto p-4 text-xs whitespace-pre-wrap break-all" tabindex="0">{text}</pre>
{/snippet}
