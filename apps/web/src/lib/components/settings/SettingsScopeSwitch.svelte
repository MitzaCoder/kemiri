<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { harness } from '#lib/harness.svelte.js';
	import { activeProjects, currentProject, type CurrentProject } from '#lib/projects.js';
	import { LAST_PROJECT_KEY, LAST_COMPUTER_KEY, parseLastProject, resolveSettingsProject, resolveSettingsComputer } from '#lib/settings-scope.js';
	import { SETTINGS_SCOPES, backendSettingsHref, generalSettingsHref, projectSettingsHref, projectSectionAvailable, type SettingsLocation } from '#lib/settings.js';
	import { navigateSettings } from '#lib/settings-navigation.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import Segmented from './Segmented.svelte';

	let { location }: { location: SettingsLocation } = $props();
	let lastProject = $state<CurrentProject>();
	let lastComputerId = $state<string | null>(null);
	let pickerOpen = $state(false);
	onMount(() => {
		try {
			lastProject = parseLastProject(localStorage.getItem(LAST_PROJECT_KEY));
			lastComputerId = localStorage.getItem(LAST_COMPUTER_KEY);
		} catch { /* Optional device storage. */ }
	});

	const projectOnScreen = $derived(location.scope === 'project' ? location : undefined);
	const computerOnScreen = $derived(location.scope !== 'device' ? harness.backend(location.backendId) : undefined);
	const originProject = $derived(currentProject(page.state.navigation?.visit?.originHref?.split(/[?#]/)[0] ?? ''));
	const projectTarget = $derived(resolveSettingsProject(harness.backends, projectOnScreen ?? originProject, lastProject));
	const computerTarget = $derived(resolveSettingsComputer(harness.backends, projectOnScreen ?? originProject, lastComputerId));
	const projectName = $derived(computerOnScreen?.projects.find(project => project.id === projectOnScreen?.projectId)?.name);
	const options = $derived(SETTINGS_SCOPES.map(option => ({ ...option,
		disabled: option.value === 'project' ? !projectTarget && !projectOnScreen : option.value === 'computer' && !computerTarget,
		hint: option.value === 'project' && !projectTarget && !projectOnScreen ? 'No project yet' : undefined,
	})));

	$effect(() => {
		if (location.scope !== 'computer' || !computerOnScreen) return;
		lastComputerId = computerOnScreen.id;
		try { localStorage.setItem(LAST_COMPUTER_KEY, computerOnScreen.id); } catch { /* Optional device storage. */ }
	});

	function switchScope(scope: string): void {
		if (scope === location.scope) return;
		pickerOpen = false;
		if (scope === 'project' && projectTarget) void navigateSettings(projectSettingsHref(projectTarget.backendId, projectTarget.projectId), true);
		if (scope === 'computer' && computerTarget) void navigateSettings(backendSettingsHref(computerTarget), true);
		if (scope === 'device') void navigateSettings(generalSettingsHref(), true);
	}

	function changeProject(backendId: string, projectId: string): void {
		pickerOpen = false;
		if (location.scope !== 'project' || (backendId === location.backendId && projectId === location.projectId)) return;
		const backend = harness.backend(backendId);
		const project = backend?.projects.find(project => project.id === projectId);
		const section = location.section;
		const keepsSection = section && backend && project && projectSectionAvailable(section, {
			supports: feature => backend.supports(feature), links: project.links !== undefined,
			longPromptCache: project.longPromptCache !== undefined, pagePrivacy: project.blockArtifactRequests !== undefined,
			repository: project.repository,
		});
		void navigateSettings(projectSettingsHref(backendId, projectId, keepsSection ? section : 'general'), true);
	}
</script>

<Segmented {options} value={location.scope} onchange={switchScope} label="Settings scope" class="w-full sm:w-fit [&_button]:px-1 sm:[&_button]:px-4" />
<div class="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
	<p class="min-w-0">
		{#if location.scope === 'project'}
			Changes here apply to {projectName ?? 'this project'} on every device.
		{:else if location.scope === 'computer'}
			Changes here apply to every project on {computerOnScreen?.name ?? 'this computer'}.
		{:else}
			Changes here apply only to this browser.
		{/if}
	</p>
	{#if location.scope === 'project' && harness.backends.some(backend => activeProjects(backend.projects).length) || location.scope === 'computer' && harness.backends.length > 1}
		<Popover.Root bind:open={pickerOpen}>
			<Popover.Trigger class="min-h-11 shrink-0 rounded-lg px-2 font-medium text-foreground underline underline-offset-4 sm:min-h-8" aria-label={location.scope === 'project' ? 'Change project' : 'Change computer'}>Change</Popover.Trigger>
			<Popover.Content align="end" class="max-h-80 w-64 overflow-y-auto p-2" aria-label={location.scope === 'project' ? 'Projects by computer' : 'Computers'}>
				{#each harness.backends as backend (backend.id)}
					{#if location.scope === 'project'}
						{@const projects = activeProjects(backend.projects)}
						{#if projects.length}
							<p class="px-3 py-1 text-xs font-medium text-muted-foreground">{backend.name}</p>
							{#each projects as project (project.id)}
								<Button variant="ghost" class="min-h-11 w-full justify-start" onclick={() => changeProject(backend.id, project.id)}>{project.name}</Button>
							{/each}
						{/if}
					{:else if location.scope === 'computer'}
						<Button variant="ghost" class="min-h-11 w-full justify-start" onclick={() => {
							pickerOpen = false;
							if (location.scope === 'computer' && location.backendId !== backend.id) void navigateSettings(backendSettingsHref(backend.id, location.section), true);
						}}>{backend.name}</Button>
					{/if}
				{/each}
			</Popover.Content>
		</Popover.Root>
	{/if}
</div>
{#if options[0]?.hint}<p class="text-xs text-muted-foreground">No project yet</p>{/if}
