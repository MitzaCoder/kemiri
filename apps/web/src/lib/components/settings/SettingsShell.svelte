<script lang="ts">
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import XIcon from '@lucide/svelte/icons/x';
	import { page } from '$app/state';
	import { settingsParentHref, settingsLocation, backendSettingsHref, generalSettingsHref, projectSettingsHref, SETTINGS_SCOPES, GENERAL_SECTIONS, COMPUTER_SECTIONS, PROJECT_SECTIONS } from '#lib/settings.js';
	import { inAppBackVisible } from '#lib/settings-navigation.js';
	import { settingsUp, settingsClose, mcpListUp } from '#lib/settings-navigation.svelte.js';
	import type { Snippet } from 'svelte';
	import ProjectsMenuButton from '#lib/components/ProjectsMenuButton.svelte';
	import SettingsScopeSwitch from './SettingsScopeSwitch.svelte';
	import SettingsNav, { type SettingsNavItem } from '#lib/components/settings/SettingsNav.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { overlayScroll } from '#lib/scrollbars.js';

	/** One frame at every width. Back follows history, breadcrumbs go Up, Close ends the visit.
	 * Resizing changes only layout. A retained index stays a list with no selected section.
	 */
	let {
		items,
		activeId,
		navLabel,
		leaveHref,
		children
	}: {
		items: readonly SettingsNavItem[];
		activeId?: string;
		navLabel: string;
		/** Cold-link Close fallback; warm visits pop to their exact origin. */
		leaveHref: string;
		children?: Snippet;
	} = $props();

	const location = $derived(settingsLocation(page.url.pathname));
	const rootHref = $derived(location?.scope === 'project' ? projectSettingsHref(location.backendId, location.projectId)
		: location?.scope === 'computer' ? backendSettingsHref(location.backendId) : generalSettingsHref());
	const atList = $derived(page.url.pathname.replace(/\/$/, '') === rootHref && items.length > 0);
	const mcpSelected = $derived(page.state.mcp?.selectedId);
	const upHref = $derived(mcpSelected ? page.url.pathname : settingsParentHref(page.url.pathname) ?? (!atList && page.url.pathname !== rootHref ? rootHref : undefined));
	function goUp(to: string): void { if (mcpSelected && to === page.url.pathname) mcpListUp(); else settingsUp(to); }
	const breadcrumbs = $derived.by(() => {
		const scopeLabel = SETTINGS_SCOPES.find(scope => scope.value === location?.scope)?.label ?? 'This device';
		const crumbs = [{ href: generalSettingsHref(), label: 'Settings' }, { href: rootHref, label: scopeLabel }];
		if (page.url.pathname.replace(/\/$/, '') !== rootHref) {
			const sections = location?.scope === 'project' ? PROJECT_SECTIONS : location?.scope === 'computer' ? COMPUTER_SECTIONS : GENERAL_SECTIONS;
			crumbs.push({ href: page.url.pathname, label: sections.find(section => section.id === location?.section)?.label ?? 'Unknown section' });
		}
		if (mcpSelected) crumbs.push({ href: page.url.pathname, label: mcpSelected });
		return crumbs;
	});
	const upLabel = $derived(mcpSelected ? 'Connected apps' : atList && location?.scope === 'computer' ? 'Computers' : breadcrumbs.at(-2)?.label ?? 'Settings');
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
				{#if atList && location?.scope === 'computer' && upHref}
					<Button variant="ghost" class="hidden h-11 px-3 md:inline-flex" onclick={() => goUp(upHref!)} aria-label="Up to Computers"><ArrowLeftIcon /> Computers</Button>
				{/if}
				<nav aria-label="Settings breadcrumbs" class="hidden min-w-0 flex-1 flex-wrap items-center md:flex">
					{#each breadcrumbs as crumb, index}
						{#if index > 0}<span aria-hidden="true">›</span>{/if}
						{#if index < breadcrumbs.length - 1}
							<Button variant="ghost" class="h-11 px-3" onclick={() => goUp(crumb.href)} aria-label={`Up to ${crumb.label}`}>{crumb.label}</Button>
						{:else}<span class="px-3 text-sm" aria-current="page">{crumb.label}</span>{/if}
					{/each}
				</nav>
				{#if upHref}
					<Button variant="ghost" class="h-11 min-w-0 flex-1 px-3 text-sm md:hidden" onclick={() => goUp(upHref)} data-settings-up>
						<span class="truncate">Up to {upLabel}</span>
					</Button>
				{/if}
				<Button variant="ghost" class="ml-auto h-11 min-w-11 px-3" aria-label="Close settings" title="Close settings" onclick={() => settingsClose(leaveHref)}><XIcon /></Button>
			</div>
			<h1 class="text-2xl font-bold tracking-tight">Settings</h1>
			{#if location}<SettingsScopeSwitch {location} />{/if}
		</header>

		<div class={atList ? 'md:max-w-md' : 'md:grid md:grid-cols-[13.5rem_minmax(0,1fr)] md:items-start md:gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10'}>
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
