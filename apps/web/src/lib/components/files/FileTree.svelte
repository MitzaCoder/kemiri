<script lang="ts">
	import Folder from '@lucide/svelte/icons/folder';
	import File from '@lucide/svelte/icons/file';
	import Link from '@lucide/svelte/icons/link';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { tick } from 'svelte';
	import type { FileTreeRow } from '#lib/code/files-view.js';
	let { rows, expanded, selected, phone, onactivate, oncollapse }: {
		rows: FileTreeRow[]; expanded: ReadonlySet<string>; selected: string; phone: boolean;
		onactivate: (row: FileTreeRow) => void; oncollapse: (row: FileTreeRow) => void;
	} = $props();
	let activePath = $state<string>();
	let tree = $state<HTMLElement>();
	const activeIndex = $derived(Math.max(0, rows.findIndex(row => row.path === (activePath ?? selected))));
	const treeId = $props.id();
	async function focusRow(index: number) {
		activePath = rows[index]?.path;
		await tick();
		tree?.querySelector('[aria-current="location"]')?.scrollIntoView({ block: 'nearest' });
	}
	function keydown(event: KeyboardEvent) {
		const row = rows[activeIndex];
		if (!row) return;
		let index = activeIndex;
		switch (event.key) {
			case 'ArrowDown': index = Math.min(rows.length - 1, index + 1); break;
			case 'ArrowUp': index = Math.max(0, index - 1); break;
			case 'Home': index = 0; break;
			case 'End': index = rows.length - 1; break;
			case 'ArrowRight':
				if (row.entry.kind === 'dir' && (phone || !expanded.has(row.path))) onactivate(row);
				else if (rows[index + 1]?.parent === row.path) index++;
				break;
			case 'ArrowLeft':
				if (expanded.has(row.path) && !phone) oncollapse(row);
				else { const parent = rows.findIndex(item => item.path === row.parent); if (parent >= 0) index = parent; }
				break;
			case 'Enter': case ' ': onactivate(row); break;
			default: return;
		}
		event.preventDefault();
		void focusRow(index);
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (this composite widget uses aria-activedescendant) -->
<div class="tree" role="tree" aria-label="Project files" tabindex="0" bind:this={tree}
	aria-activedescendant={rows.length ? `${treeId}-${activeIndex}` : undefined} onkeydown={keydown}>
	{#each rows as row, index (row.path)}
		{@const folder = row.entry.kind === 'dir'}
		<!-- svelte-ignore a11y_click_events_have_key_events (keyboard activation is handled by the tree) -->
		<div id={`${treeId}-${index}`} role="treeitem" tabindex="-1" aria-level={row.depth} aria-selected={selected === row.path}
			aria-current={index === activeIndex ? 'location' : undefined} aria-expanded={folder && !phone ? expanded.has(row.path) : undefined}
			aria-label={`${row.entry.name}${row.entry.kind === 'link' ? ', symbolic link' : ''}`} class="row" class:selected={selected === row.path}
			style:--depth={row.depth - 1} title={row.path} onclick={() => { activePath = row.path; tree?.focus({ preventScroll: true }); onactivate(row); }}>
			{#if folder}<ChevronRight size={13} class={expanded.has(row.path) && !phone ? 'rotate-90' : ''} /><Folder size={15} />
			{:else}<span class="w-[13px]"></span>{#if row.entry.kind === 'link'}<Link size={15} />{:else}<File size={15} />{/if}{/if}
			<span class="truncate">{row.entry.name}</span>
		</div>
	{/each}
</div>

<style>
	.tree { min-width: 0; padding: 4px 5px 12px; outline-offset: -2px; }
	.row { display:flex; align-items:center; gap:6px; min-width:0; min-height:29px; padding:3px 6px 3px calc(6px + var(--depth) * 13px); cursor:pointer; border-radius:6px; font-size:13px; }
	.row :global(svg) { flex:none; color:var(--chat-fg-muted); }
	.row.selected { background:var(--chat-surface-2); box-shadow:inset 2px 0 var(--accent-2); }
	.row:hover, .tree:focus-visible .row[aria-current='location'] { background:var(--chat-surface-2); outline:1px solid var(--chat-border); }
	@media(max-width:640px) { .row { min-height:44px; } }
</style>
