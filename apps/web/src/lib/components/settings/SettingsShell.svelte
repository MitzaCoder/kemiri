<script lang="ts">
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import XIcon from '@lucide/svelte/icons/x';
	import { page } from '$app/state';
	import { harness } from '#lib/harness.svelte.js';
	import { settingsParentHref, backendSettingsHref } from '#lib/settings.js';
	import { inAppBackVisible } from '#lib/settings-navigation.js';
	import { settingsUp, settingsClose, mcpListUp } from '#lib/settings-navigation.svelte.js';
	import type { Snippet } from 'svelte';
	import ProjectsMenuButton from '#lib/components/ProjectsMenuButton.svelte';
	import SettingsNav, { type SettingsNavItem } from '#lib/components/settings/SettingsNav.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { overlayScroll } from '#lib/scrollbars.js';

	/** One frame at every width. Back follows history, breadcrumbs go Up, Close ends the visit.
	 * Resizing changes only layout. An index has no selected section and never redirects.
	 */
	let {
		items,
		activeId,
		navLabel,
		leaveHref,
		parentHref,
		parentLabel,
		header,
		children
	}: {
		items: readonly SettingsNavItem[];
		activeId?: string;
		navLabel: string;
		/** Cold-link Close fallback; warm visits pop to their exact origin. */
		leaveHref: string;
		parentHref?: string;
		parentLabel?: string;
		header: Snippet;
		children?: Snippet;
	} = $props();

	const rootHref = $derived(items[0] ? settingsParentHref(items[0].href) : page.url.pathname);
	const atList = $derived(page.url.pathname === rootHref);
	const mcpSelected = $derived(page.state.mcp?.selectedId);
	const upHref = $derived(mcpSelected ? page.url.pathname : parentHref ?? (!atList ? rootHref : undefined));
	function goUp(to: string): void { if (mcpSelected && to === page.url.pathname) mcpListUp(); else settingsUp(to); }
	const breadcrumbs = $derived.by(() => {
		const paths = [page.url.pathname];
		let parent = settingsParentHref(page.url.pathname);
		while (parent) { paths.unshift(parent); parent = settingsParentHref(parent); }
		if (paths.length === 1 && !atList && rootHref) paths.unshift(rootHref);
		const crumbs = paths.map(path => ({ href: path, label:
			items.find(item => item.href === path)?.label
			?? harness.backends.find(backend => backendSettingsHref(backend.id) === path)?.name
			?? (path === rootHref ? (navLabel.startsWith('Project') ? 'Project settings' : 'Settings')
				: path.endsWith('/accounts') ? 'Accounts' : path.endsWith('/mcp') ? 'MCP' : 'Unknown section')
		}));
		if (mcpSelected) crumbs.push({ href: page.url.pathname, label: mcpSelected });
		return crumbs;
	});
	const upLabel = $derived(mcpSelected ? 'MCP servers' : parentLabel ?? breadcrumbs.at(-2)?.label ?? 'Settings');
</script>

<div class="relative h-full w-full">
<main
	use:overlayScroll={'parent'}
	class="h-full w-full overflow-y-auto pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]"
>
	<div class="mx-auto flex w-full max-w-5xl flex-col gap-5 px-3 sm:px-5">
		<header class="flex flex-col gap-2">
			<div class="flex items-center gap-1">
				<div class="[&_button]:size-11 lg:hidden"><ProjectsMenuButton /></div>
				{#if inAppBackVisible(page.state.navigation)}
					<Button variant="ghost" class="h-11 min-w-11 px-3" onclick={() => history.back()} aria-label="Back">
						<ArrowLeftIcon /> <span class="max-sm:sr-only">Back</span>
					</Button>
				{/if}
				<nav aria-label="Settings breadcrumbs" class="hidden min-w-0 flex-1 flex-wrap items-center md:flex">
					{#each breadcrumbs as crumb, index}
						{#if index > 0}<span aria-hidden="true">›</span>{/if}
						{#if index < breadcrumbs.length - 1}
							<Button variant="ghost" class="h-11 px-3" onclick={() => goUp(crumb.href)} aria-label={`Up to ${crumb.label}`}>{crumb.label}</Button>
						{:else}<span class="px-3 text-sm" aria-current="page">{crumb.label}</span>{/if}
					{/each}
				</nav>
				{#if !atList && upHref}
					<Button variant="ghost" class="h-11 min-w-0 flex-1 px-3 text-sm md:hidden" onclick={() => goUp(upHref)} data-settings-up>
						<span class="truncate">Up to {upLabel}</span>
					</Button>
				{/if}
				<Button variant="ghost" class="ml-auto h-11 min-w-11 px-3" aria-label="Close settings" title="Close settings" onclick={() => settingsClose(leaveHref)}><XIcon /></Button>
			</div>
			{@render header()}
		</header>

		<div class="md:grid md:grid-cols-[13.5rem_minmax(0,1fr)] md:items-start md:gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
			<div class="{atList ? '' : 'max-md:hidden'} md:sticky md:top-3">
				<SettingsNav {items} {activeId} label={navLabel} />
			</div>
			<div class="min-w-0 {atList ? 'max-md:hidden' : ''}" data-settings-content>
				{@render children?.()}
			</div>
		</div>
	</div>
</main>
</div>
