<script lang="ts">
	import { navigateSettings } from '#lib/settings-navigation.svelte.js';
	import { page } from '$app/state';
	import { projectSettingsHref } from '#lib/settings.js';

	/**
	 * `.../settings` is the section index at every width. A schedule
	 * notification links here with `#schedule-<id>` (Android's route parser knows only `.../settings`), so that
	 * address goes straight to Scheduled tasks, on any screen, keeping the fragment.
	 */
	const backendId = $derived(page.params.backend ?? '');
	const projectId = $derived(page.params.id ?? '');
	const toSchedule = $derived(page.url.hash.startsWith('#schedule-'));

	$effect(() => {
		if (toSchedule) {
			void navigateSettings(`${projectSettingsHref(backendId, projectId, 'schedules')}${page.url.hash}`, true);
		}
	});
</script>

{#if !toSchedule}
	<section class="flex flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10">
		<h2 class="text-xl font-semibold">Project settings overview</h2>
		<p class="text-sm text-muted-foreground">Choose a section to manage this project’s agents, tools and workspace.</p>
	</section>
{/if}
