<script lang="ts">
	import { page } from '$app/state';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import AdvancedSection from '#lib/components/settings/AdvancedSection.svelte';
	import CoordinatorSection from '#lib/components/settings/CoordinatorSection.svelte';
	import NotFoundNote from '#lib/components/settings/NotFoundNote.svelte';
	import ProjectGeneralSection from '#lib/components/settings/ProjectGeneralSection.svelte';
	import { settingsUp } from '#lib/settings-navigation.svelte.js';
	import ProjectSkillsSection from '#lib/components/settings/ProjectSkillsSection.svelte';
	import ProjectMcpSection from '#lib/components/settings/ProjectMcpSection.svelte';
	import WorkersSection from '#lib/components/settings/WorkersSection.svelte';
	import SchedulesSection from '#lib/components/SchedulesSection.svelte';
	import { harness } from '#lib/harness.svelte.js';
	import { PROJECT_SECTIONS, isProjectSection, projectSectionAvailable, projectAdvancedGroupNote, projectSettingsHref } from '#lib/settings.js';

	/** One section of a project's settings, by the last URL segment. */
	const backend = $derived(harness.backend(page.params.backend ?? ''));
	const projectId = $derived(page.params.id ?? '');
	const section = $derived(page.params.section ?? '');
	const project = $derived(backend?.projects.find((entry) => entry.id === projectId));
	const known = $derived(isProjectSection(section) ? section : undefined);
	const repository = $derived(project?.repository);
	const note = $derived(known === 'advanced' ? projectAdvancedGroupNote(page.url.hash, repository) : undefined);
	const available = $derived(
		backend !== undefined &&
			PROJECT_SECTIONS.some(
				(entry) =>
					entry.id === section &&
					projectSectionAvailable(entry.id, {
						supports: (feature) => backend.supports(feature),
						links: project?.links !== undefined,
						longPromptCache: project?.longPromptCache !== undefined,
						pagePrivacy: project?.blockArtifactRequests !== undefined,
						repository
					})
			)
	);
</script>

{#if backend !== undefined && project !== undefined}
	{#if !known}
		<NotFoundNote title="Unknown project settings section">
			This settings section does not exist. <a class="underline" href={projectSettingsHref(backend.id, projectId)} onclick={(event) => { event.preventDefault(); settingsUp(projectSettingsHref(backend.id, projectId)); }}>Choose a settings section</a>
		</NotFoundNote>
	{:else if !available && note === undefined}
		<NotFoundNote title="Not available here">
			{backend.name} does not offer this section.
			<a class="underline" href={projectSettingsHref(backend.id, projectId)} onclick={(event) => { event.preventDefault(); settingsUp(projectSettingsHref(backend.id, projectId)); }}>
				<ArrowLeftIcon class="inline size-3.5" aria-hidden="true" /> Settings
			</a>
		</NotFoundNote>
	{:else if section === 'general'}
		{#key `${backend.id}:${projectId}`}<ProjectGeneralSection {backend} {projectId} />{/key}
	{:else if section === 'coordinator'}
		<CoordinatorSection {backend} {projectId} />
	{:else if section === 'workers'}
		<WorkersSection {backend} {projectId} />
	{:else if section === 'schedules'}
		<SchedulesSection {backend} {projectId} />
	{:else if section === 'mcp'}
		{#key `${backend.id}:${projectId}`}<ProjectMcpSection {backend} {projectId} />{/key}
	{:else if section === 'skills'}
		{#key `${backend.id}:${projectId}`}<ProjectSkillsSection {backend} {projectId} />{/key}
	{:else if section === 'advanced'}
		{#key `${backend.id}:${projectId}`}<AdvancedSection {backend} {projectId} />{/key}
	{/if}
{/if}
