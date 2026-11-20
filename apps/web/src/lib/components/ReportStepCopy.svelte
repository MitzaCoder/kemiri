<script lang="ts">
	import { copyText } from '#lib/clipboard.js';
	import { Button } from './ui/button/index.js';

	let { text, language }: { text: string; language?: string } = $props();
	let copyFeedback = $state('');
	let clearFeedback: ReturnType<typeof setTimeout> | undefined;
	async function copy() {
		copyFeedback = await copyText(text) ? 'Copied' : 'Could not copy';
		clearTimeout(clearFeedback);
		clearFeedback = setTimeout(() => { copyFeedback = ''; }, 2000);
	}
	$effect(() => () => clearTimeout(clearFeedback));
</script>

<div class="step-copy">
	<pre><code>{text}</code></pre>
	<div class="copy-controls">
		{#if language}<span>{language}</span>{/if}
		<span class="sr-only" role="status">{copyFeedback}</span>
		<Button variant="ghost" aria-label={copyFeedback || 'Copy step text'} class="ml-auto min-h-11" onclick={copy}>
			{copyFeedback || 'Copy'}
		</Button>
	</div>
</div>

<style>
	.step-copy { margin-block-start: .4em; border: 1px solid var(--chat-border); border-radius: var(--radius-lg); background: var(--chat-surface-2); }
	pre { margin: 0; padding: .65em .85em; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .875em; tab-size: 4; }
	.copy-controls { display: flex; align-items: center; flex-wrap: wrap; gap: .5em; padding-inline: .85em .25em; border-top: 1px solid var(--chat-border); color: var(--chat-fg-muted); font-size: .875em; }
</style>
