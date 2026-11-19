<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import SettingsShell from '#lib/components/settings/SettingsShell.svelte';
	import type { SettingsNavItem } from '#lib/components/settings/SettingsNav.svelte';
	import { harness } from '#lib/harness.svelte.js';
	import { notifications } from '#lib/notifications.svelte.js';
	import { archivedProjects } from '#lib/projects.js';
	import {
		GENERAL_SECTIONS,
		COMPUTER_SECTIONS,
		generalSettingsHref,
		settingsLocation,
		backendSettingsHref
	} from '#lib/settings.js';
	import type { LayoutProps } from './$types';

	/** General settings: the frame (section list and content). Each section is a route under /settings. */
	let { children }: LayoutProps = $props();

	harness.load();
	onMount(() => harness.start());

	const location = $derived(settingsLocation(page.url.pathname));
	const activeId = $derived(location?.section);
	const computer = $derived(location?.scope === 'computer' ? harness.backend(location.backendId) : undefined);

	const archivedCount = $derived(
		harness.backends.reduce((count, backend) => count + archivedProjects(backend.projects).length, 0)
	);
	const offline = $derived(harness.backends.filter((backend) => !backend.ready).length);

	const chips: Record<string, SettingsNavItem['chip']> = $derived({
		backends: offline > 0 ? { label: `${offline} offline`, tone: 'warn' } : undefined,
		notifications: notifications.enabled ? { label: 'On', tone: 'ok' } : { label: 'Off', tone: 'muted' },
		archived: archivedCount > 0 ? { label: String(archivedCount), tone: 'muted' } : undefined
	});

	const items = $derived<SettingsNavItem[]>(location?.scope === 'computer'
		? computer ? COMPUTER_SECTIONS.map(section => ({ ...section, href: backendSettingsHref(computer.id, section.id) })) : []
		: GENERAL_SECTIONS.map(section => ({ ...section, href: generalSettingsHref(section.id), chip: chips[section.id] })));

</script>

<svelte:head>
	<title>Settings · Kemiri</title>
</svelte:head>

<SettingsShell {items} {activeId} navLabel={location?.scope === 'computer' ? 'Computer settings sections' : 'Device settings sections'} leaveHref="/">
	{@render children()}
</SettingsShell>
