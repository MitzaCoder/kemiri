<script lang="ts">
	import { page } from '$app/state';
	import AboutSection from '#lib/components/settings/AboutSection.svelte';
	import AppearanceSection from '#lib/components/settings/AppearanceSection.svelte';
	import ArchivedSection from '#lib/components/settings/ArchivedSection.svelte';
	import NotificationsSection from '#lib/components/settings/NotificationsSection.svelte';
	import NotFoundNote from '#lib/components/settings/NotFoundNote.svelte';
	import { settingsUp } from '#lib/settings-navigation.svelte.js';
	import { generalSettingsHref } from '#lib/settings.js';

	const section = $derived(page.params.section);
</script>

{#if section === 'appearance'}
	<AppearanceSection />
{:else if section === 'about'}
	<AboutSection />
{:else if section === 'notifications'}
	<NotificationsSection />
{:else if section === 'archived'}
	<ArchivedSection />
{:else}
	<NotFoundNote title="Unknown settings section">
		This settings section does not exist. <a class="underline" href={generalSettingsHref()} onclick={(event) => { event.preventDefault(); settingsUp(generalSettingsHref()); }}>Choose a settings section</a>
	</NotFoundNote>
{/if}
