<script lang="ts">
	import { onMount } from 'svelte';
	import type { HarnessClient } from '@kemiri/client';
	import type { CodeRoot } from '@kemiri/protocol';
	import { searchCursor } from '#lib/code/files-view.js';
	let { client, projectId, root, onselect, autocue = false }: {
		client: HarnessClient; projectId: string; root: CodeRoot; onselect: (path: string) => void; autocue?: boolean;
	} = $props();
	let input = $state<HTMLInputElement>();
	let query = $state('');
	let paths = $state<string[]>([]);
	let active = $state(-1);
	let open = $state(false);
	let pending = $state(false);
	let problem = $state('');
	const componentId = $props.id();
	const listId = `${componentId}-results`;
	const showing = $derived(open && query.trim() !== '');

	onMount(() => { if (autocue) focus(); });
	export function focus(): void { input?.focus(); input?.select(); }
	$effect(() => {
		const text = query.trim(), requestedRoot = root;
		paths = []; active = -1; problem = ''; pending = !!text;
		if (!text) return;
		let cancelled = false;
		const wait = setTimeout(() => void client.searchFiles(projectId, requestedRoot, text).then(({paths: matches}) => {
			if (!cancelled) { paths = matches; pending = false; }
		}, () => { if (!cancelled) { problem = 'Could not search this checkout.'; pending = false; } }), 145);
		return () => { cancelled = true; clearTimeout(wait); };
	});
	function choose(path: string) { open = false; query = ''; onselect(path); }
	function key(event: KeyboardEvent) {
		if (event.key === 'Escape' && showing) { event.preventDefault(); event.stopPropagation(); open = false; }
		if (!query.trim()) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault(); open = true; active = searchCursor(active, event.key === 'ArrowDown' ? 1 : -1, paths.length);
			document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
		}
		if (event.key === 'Enter' && showing && paths.length) { event.preventDefault(); choose(paths[Math.max(0, active)]!); }
	}
</script>
<div class="file-search">
	<label class="sr-only" for={`${listId}-input`}>Go to file</label>
	<input id={`${listId}-input`} bind:this={input} bind:value={query} role="combobox" aria-expanded={showing} aria-autocomplete="list"
		aria-controls={listId} aria-activedescendant={showing && active >= 0 ? `${listId}-${active}` : undefined}
		aria-keyshortcuts="Control+P Meta+P" placeholder="Go to file…" autocomplete="off" maxlength="256" oninput={() => open = true}
		onfocus={() => open = true} onblur={() => open = false} onkeydown={key} />
	{#if showing}
		<div class="results">
			{#if pending || problem || !paths.length}<p role="status">{pending ? 'Searching…' : problem || 'No matching files'}</p>{/if}
			<div id={listId} role="listbox" aria-label="Matching files">
				{#each paths as path, index (path)}
					<!-- svelte-ignore a11y_click_events_have_key_events (combobox owns the keyboard) -->
					<div id={`${listId}-${index}`} role="option" tabindex="-1" aria-selected={active === index} onmousedown={event => event.preventDefault()} onclick={() => choose(path)}>{path}</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
<style>
	.file-search { position:relative; min-width:0; }
	input { width:100%; min-height:34px; border:1px solid var(--chat-border); border-radius:7px; padding:4px 8px; background:var(--chat-bg); font-size:13px; }
	.results { position:absolute; inset-inline:0; z-index:8; max-height:40dvh; overflow:auto; background:var(--chat-surface); border:1px solid var(--chat-border); border-radius:7px; box-shadow:0 4px 12px #0002; }
	.results [role='option'], .results p { padding:7px 8px; font:12px var(--font-mono); overflow-wrap:anywhere; }
	.results [role='option'] { cursor:pointer; }
	.results [role='option']:hover, .results [aria-selected='true'] { background:var(--chat-surface-2); }
	@media(max-width:640px) { input { min-height:44px; font-size:16px; } .results [role='option'] { min-height:44px; } }
</style>
