<script lang="ts">
	import { overlayScroll } from '#lib/scrollbars.js';
	import { diffRows, diffSegments, type DiffToken, type WordRange, type DiffRow } from '#lib/code/diff-rows.js';
	import { highlightRows, normalizeLang } from '#lib/markdown/highlight.js';

	let { diff, lang, format = 'display', enhanced = true }: { diff: string; lang?: string; format?: 'display' | 'patch'; enhanced?: boolean } = $props();
	const rows = $derived(diffRows(diff, format));
	let decoration = $state.raw<{ rows: DiffRow[]; tokens: DiffToken[][]; marks: WordRange[][] }>();
	const decorated = $derived(decoration?.rows === rows ? decoration : undefined);

	$effect(() => {
		const snapshot = rows;
		const language = normalizeLang(lang);
		if (!enhanced || diff.length > 24_000 || snapshot.length > 500) return;
		let disposed = false;
		const tokens: DiffToken[][] = [];
		const syntax = async (excluded: 'add' | 'del') => {
			if (language === 'plaintext') return;
			const source = snapshot.map(row => row.kind === excluded || row.kind === 'gap' || row.kind === 'meta' ? '' : row.text);
			const styled = await highlightRows(source.join('\n'), language);
			for (let i = 0; i < styled.length; i++) {
				const kind = snapshot[i]?.kind;
				if (kind === (excluded === 'add' ? 'del' : 'add') || (kind === 'ctx' && excluded === 'del')) tokens[i] = styled[i] ?? [];
			}
		};
		void Promise.all([import('#lib/code/diff-words.js').then(module => module.diffWordRanges(snapshot)),
			Promise.all([syntax('add'), syntax('del')]).catch(() => {})]).then(([marks]) => {
				if (!disposed) decoration = { rows: snapshot, tokens, marks };
			});
		return () => { disposed = true; };
	});
</script>

<div class="relative">
<div use:overlayScroll={'parent'} class="diff overflow-x-auto font-mono text-[0.78rem] leading-[1.6]">
	{#each rows as line, index (index)}
		<div class="flex min-w-max {line.kind}">
			<span class="w-10 shrink-0 pr-2 text-right text-(--chat-fg-subtle) select-none">{line.number}</span>
			<span class="w-4 shrink-0 text-center select-none"
				>{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</span
			>
			<span class="pr-4 whitespace-pre">{#if decorated}{#each diffSegments(line.text, decorated.tokens[index] ?? [], decorated.marks[index] ?? []) as segment}<span class="diff-token" class:word-mark={segment.marked} style:--diff-light={segment.light} style:--diff-dark={segment.dark}>{segment.text}</span>{/each}{:else}{line.text}{/if}</span>
		</div>
	{/each}
</div>
</div>

<style>
	.diff {
		padding: 0.5rem 0;
		tab-size: 4;
	}
	.add {
		background: color-mix(in oklab, var(--chat-success) 13%, transparent);
	}
	.add > span:nth-child(2) {
		color: var(--chat-success);
	}
	.del {
		background: color-mix(in oklab, var(--chat-danger) 12%, transparent);
	}
	.del > span:nth-child(2) {
		color: var(--chat-danger);
	}
	.diff-token { color: var(--diff-light, inherit); }
	:global(.dark) .diff-token { color: var(--diff-dark, inherit); }
	.add .word-mark { background: color-mix(in oklab, var(--chat-success) 28%, transparent); box-shadow: inset 0 -1px var(--chat-success); }
	.del .word-mark { background: color-mix(in oklab, var(--chat-danger) 27%, transparent); box-shadow: inset 0 -1px var(--chat-danger); }
	.gap, .meta {
		color: var(--chat-fg-subtle);
	}
</style>
