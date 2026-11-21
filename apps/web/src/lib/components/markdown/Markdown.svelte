<script lang="ts">
	import { useFilesNavigation } from '#lib/code/files-navigation.svelte.js';
	import { fileReferences } from '#lib/code/file-location.js';
	import { useOpenTaskId } from '#lib/task-detail-context.js';
	import { renderInline, toBlocks } from '#lib/markdown/parse.js';
	import { useRefLinks } from '#lib/ref-links.svelte.js';
	import { linkRefMentions } from '#lib/refs.js';
	import DiffView from '../chat/DiffView.svelte';
	import CodeBlock from './CodeBlock.svelte';
	import { useTaskLinks } from '#lib/task-links.svelte.js';
	import { overlayScrollWithin } from '#lib/scrollbars.js';

	/**
	 * Rendered model markdown; code blocks get highlighting and a copy button. On a project's screens, ticket keys and PR
	 * numbers its link settings know become links (`provideRefLinks`).
	 */
	let {
		source,
		streaming = false,
		userMessage = false,
		inline = false,
		class: className = ''
	}: { source: string; streaming?: boolean; userMessage?: boolean; inline?: boolean; class?: string } = $props();

	const refLinks = useRefLinks();
	const taskLinks = useTaskLinks();
	const openTaskId = useOpenTaskId();
	const linked = $derived.by(() => {
		const links = refLinks()?.links;
		return links === undefined ? source : linkRefMentions(source, links, { streaming });
	});
	const files = useFilesNavigation();
	const blocks = $derived(toBlocks(linked, streaming, userMessage, taskLinks()?.title, openTaskId()));

	function fileLinks(html: string): string {
		if (!files?.available() || !html.includes(':') || typeof document === 'undefined') return html;
		const template = document.createElement('template');
		template.innerHTML = html;
		const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
		const nodes: Text[] = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
		for (const node of nodes) {
			if (node.parentElement?.closest('a, button, pre, textarea, [role=img]')) continue;
			const references = fileReferences(node.data);
			if (!references.length) continue;
			const replacement = document.createDocumentFragment();
			let last = 0;
			for (const ref of references) {
				replacement.append(node.data.slice(last, ref.offset));
				const anchor = document.createElement('a');
				anchor.dataset.checkoutReference = ref.label;
				anchor.href = files.href(ref.path, ref.line);
				anchor.textContent = ref.label;
				replacement.append(anchor);
				last = ref.offset + ref.label.length;
			}
			replacement.append(node.data.slice(last));
			node.replaceWith(replacement);
		}
		return template.innerHTML;
	}
	function openReference(event: MouseEvent) {
		if (!files?.available() || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-checkout-reference]') : null;
		const label = anchor?.dataset.checkoutReference;
		if (!label) return;
		const reference = fileReferences(label)[0];
		if (reference?.label !== label) return;
		event.preventDefault();
		void files.open(reference.path, reference.line);
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (delegates native anchor clicks) -->
<div onclick={openReference} class="md {className}" class:streaming class:md-user={userMessage} use:overlayScrollWithin={'.md-table'}>
	{#if inline}
		<!-- Sanitized with DOMPurify in renderInline(). -->
		{@html fileLinks(renderInline(linked, taskLinks()?.title, openTaskId()))}
	{:else}
		{#each blocks as block (block.key)}
			{#if block.kind === 'code'}
				{#if block.lang.trim().split(/\s+/)[0]?.toLowerCase() === 'diff'}
					<DiffView diff={block.code} format="patch" enhanced={block.closed} />
				{:else}
					<CodeBlock code={block.code} lang={block.lang} streaming={!block.closed} />
				{/if}
			{:else}
				<!-- Sanitized with DOMPurify in toBlocks(). -->
				{@html fileLinks(block.html)}
			{/if}
		{/each}
	{/if}
</div>
