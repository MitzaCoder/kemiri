<script lang="ts">
	import { page } from '$app/state';
	import ComputerSection from '#lib/components/settings/ComputerSection.svelte';
	import NotFoundNote from '#lib/components/settings/NotFoundNote.svelte';
	import { harness } from '#lib/harness.svelte.js';
	import { backendSettingsHref, generalSettingsHref, isComputerSection } from '#lib/settings.js';
	import { settingsUp } from '#lib/settings-navigation.svelte.js';

	const backend = $derived(harness.backend(page.params.id ?? ''));
	const section = $derived(page.params.section);
</script>

{#if !backend}
	<NotFoundNote title="Unknown computer">
		This computer is not configured in this browser.
		<a class="underline" href={generalSettingsHref('backends')}>Back to Computers</a>
	</NotFoundNote>
{:else if isComputerSection(section) && section !== 'accounts' && section !== 'mcp'}
	{#key backend.id}<ComputerSection {backend} {section} />{/key}
{:else}
	<NotFoundNote title="Unknown computer settings section">
		<a class="underline" href={backendSettingsHref(backend.id)} onclick={(event) => { event.preventDefault(); settingsUp(backendSettingsHref(backend.id)); }}>Choose a settings section</a>
	</NotFoundNote>
{/if}
