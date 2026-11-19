<script lang="ts">
 import { page } from '$app/state';
 import { tick } from 'svelte';
 import TicketsGroup from './TicketsGroup.svelte';
 import StorageGroup from './StorageGroup.svelte';
 import ConversationCacheGroup from './ConversationCacheGroup.svelte';
 import ReportAuditGroup from './ReportAuditGroup.svelte';
 import DeliveryGroup from './DeliveryGroup.svelte';
 import Combobox from './Combobox.svelte';
 import SettingsGroup from './SettingsGroup.svelte';
 import SettingsRow from './SettingsRow.svelte';
 import SettingsSection from './SettingsSection.svelte';
 import Switch from './Switch.svelte';
 import type { BackendConnection } from '#lib/harness.svelte.js';
 import { SaveState } from '#lib/save-state.svelte.js';
 import { projectAdvancedGroupNote, projectHasCodingSettings, projectSection, ADVANCED_GROUPS } from '#lib/settings.js';
 import { DEFAULT_UI_PROOF, type UiProof } from '@kemiri/protocol';

 let { backend, projectId }: { backend: BackendConnection; projectId: string } = $props();
 const project = $derived(backend.projects.find((entry) => entry.id === projectId));
 const section = projectSection('advanced');
 const repository = $derived(project?.repository);
 const coding = $derived(projectHasCodingSettings(repository));
 const note = $derived(projectAdvancedGroupNote(page.url.hash, repository));
 $effect(() => {
	const anchor = page.url.hash.slice(1);
	if (![...Object.values(ADVANCED_GROUPS), 'ui-proof'].some(id => id === anchor)) return;
	void tick().then(() => document.getElementById(anchor)?.scrollIntoView());
 });
 let pendingUiProof = $state<UiProof | undefined>(undefined);
 const uiProofSave = new SaveState();
 const artifactPrivacySave = new SaveState();
	// An older backend does not send the setting, so the row stays out.
	const uiProofValue = $derived(pendingUiProof ?? project?.uiProof ?? DEFAULT_UI_PROOF);
	const uiProofOptions = [
		{ value: 'screenshots-and-videos', label: 'Screenshots and videos', description: 'Before/after screenshots and a short recording. The default.' },
		{ value: 'screenshots', label: 'Screenshots', description: 'Before/after screenshots only.' },
		{ value: 'off', label: 'Off', description: 'Agents are not asked to show UI changes.' }
	];
	async function pickUiProof(next: string): Promise<void> {
		pendingUiProof = next as UiProof;
		await uiProofSave.run(() => backend.configureProject(projectId, { uiProof: next as UiProof }));
		pendingUiProof = undefined;
	}
</script>

<SettingsSection title={section.label} description={section.hint} icon={section.icon}>
	{#if project?.blockArtifactRequests !== undefined}
		<SettingsGroup title="Page privacy" term="Artifact pages">
			<SettingsRow label="Stop pages from sending data" hint="Blocks connections and form submissions from HTML pages agents make." for="artifact-privacy" status={artifactPrivacySave} control="auto">
				<Switch id="artifact-privacy" checked={project.blockArtifactRequests} disabled={artifactPrivacySave.status === 'saving'} onchange={(on) => void artifactPrivacySave.run(() => backend.configureProject(projectId, { blockArtifactRequests: on }))} />
			</SettingsRow>
		</SettingsGroup>
	{/if}
	{#if project?.longPromptCache !== undefined}
		<ConversationCacheGroup {backend} {projectId} />
	{/if}
	{#if coding && project?.uiProof !== undefined}
		<SettingsGroup id="ui-proof" title="Proof of screen changes" term="Show UI changes">
			<SettingsRow
				label="Prove UI work with"
				hint="Agents show web and app changes before review; backends and terminals are never recorded."
				for="coordinator-ui-proof"
				status={uiProofSave}
				onretry={() => void pickUiProof(uiProofValue)}
			>
				{#snippet learn()}
					Any change a user can see in a web page or an app screen is shown before it goes to review: a bug
					before and after, using the real UI in a headless browser, emulator or device. The agent saves the
					pictures (and the recording) on the task. The coordinator works out how to demo this project once and
					keeps the recipe in memory. A change reaches the coordinator on its next turn and workers started after it.
				{/snippet}
				<Combobox
					id="coordinator-ui-proof"
					options={uiProofOptions}
					value={uiProofValue}
					onchange={(next) => void pickUiProof(next)}
					aria-label="Prove UI work with"
					invalid={uiProofSave.status === 'failed'}
				/>
			</SettingsRow>
		</SettingsGroup>
	{/if}
	<ReportAuditGroup {backend} {projectId} />
	<ReportAuditGroup {backend} {projectId} watcher />
	{#if coding}
		<div id={ADVANCED_GROUPS.delivery}><DeliveryGroup {backend} {projectId} /></div>
		<TicketsGroup {backend} {projectId} />
	{/if}
	{#if note}
		<SettingsGroup id={page.url.hash.slice(1)} title={page.url.hash === '#tickets' ? 'Tickets and pull requests' : page.url.hash === '#ui-proof' ? 'Proof of screen changes' : 'Code delivery'}>
			<p class="p-4 text-sm text-muted-foreground">{note}</p>
		</SettingsGroup>
	{/if}
	{#if backend.supports('storage')}<StorageGroup {backend} {projectId} />{/if}
</SettingsSection>
