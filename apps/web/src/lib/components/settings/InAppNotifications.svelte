<script lang="ts">
	import { mutedBackendEntries, mutedProjectEntries } from '@kemiri/client';
	import { alerts } from '#lib/alerts.svelte.js';
	import { alertPopupSetting } from '#lib/alerts.js';
	import { alertSoundSetting } from '#lib/alert-sounds.js';
	import { MUTE_DURATIONS, quietPeriod, quietUntilLabel, type MuteDuration } from '#lib/alert-quiet.js';
	import { harness } from '#lib/harness.svelte.js';
	import { notifications } from '#lib/notifications.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import DoNotDisturbMenu from '#lib/components/alerts/DoNotDisturbMenu.svelte';
	import SettingsGroup from './SettingsGroup.svelte';
	import SettingsRow from './SettingsRow.svelte';
	import Switch from './Switch.svelte';

	const selectClass = 'min-h-11 w-full rounded-md border border-(--chat-border) bg-(--chat-bg) px-3 text-base';
	const mutes = $derived([
		...mutedProjectEntries(notifications.settings, notifications.muteClock),
		...mutedBackendEntries(notifications.settings, notifications.muteClock).map(mute => ({ ...mute, projectId: undefined })),
	]);
	function targetKey(backendId: string, projectId?: string): string { return JSON.stringify([backendId, projectId ?? null]); }
	function targetLabel(backendId: string, projectId?: string): string {
		const backend = harness.backend(backendId);
		const backendName = backend?.name ?? backendId;
		return projectId === undefined ? backendName : `${backend?.projects.find(project => project.id === projectId)?.name ?? projectId} · ${backendName}`;
	}
	const targets = $derived(harness.backends.flatMap(backend => [
		{ backendId: backend.id, projectId: undefined }, ...backend.projects.filter(project => !project.archived).map(project => ({ backendId: backend.id, projectId: project.id })),
	]));
	let target = $state('');
	let duration = $state<MuteDuration>('hour');
	const selected = $derived(targets.find(({ backendId, projectId }) => targetKey(backendId, projectId) === target));

	function addMute(): void {
		if (!selected) return;
		const mute = quietPeriod(duration, Date.now());
		if (selected.projectId === undefined) void notifications.setBackendMute(harness.backends, selected.backendId, mute);
		else void notifications.setProjectMute(harness.backends, selected.backendId, selected.projectId, mute);
		target = '';
		duration = 'hour';
	}

	function unmute(backendId: string, projectId?: string): void {
		if (projectId === undefined) void notifications.setBackendMute(harness.backends, backendId, null);
		else void notifications.setProjectMute(harness.backends, backendId, projectId, null);
	}
</script>

<SettingsGroup title="In the app" description="These controls apply to this browser across all computers.">
	<SettingsRow label="Pop-ups" hint="Show a card when something needs attention away from this chat." for="in-app-popups">
		<select id="in-app-popups" class={selectClass} value={alerts.popupSetting}
			onchange={(event) => alerts.setSettings({ popupSetting: alertPopupSetting(event.currentTarget.value) })}>
			<option value="everything">Everything</option>
			<option value="needs-me">Things that need me</option>
			<option value="urgent">Only urgent</option>
			<option value="off">Off</option>
		</select>
	</SettingsRow>
	<SettingsRow label="Sounds" hint={alerts.audioUnlocked ? 'Plays on the screen used last.' : 'Sounds start after your first click in this tab'} for="in-app-sounds">
		<select id="in-app-sounds" class={selectClass} value={alerts.soundSetting}
			onchange={(event) => alerts.setSettings({ soundSetting: alertSoundSetting(event.currentTarget.value) })}>
			<option value="urgent-important">Urgent and important</option>
			<option value="urgent">Only urgent</option>
			<option value="off">Off</option>
		</select>
	</SettingsRow>
	<SettingsRow label="Volume" hint="Test plays the urgent chime." for="in-app-volume">
		<div class="flex min-h-11 items-center gap-3">
			<input id="in-app-volume" class="h-11 min-w-0 flex-1 cursor-pointer accent-(--primary)" type="range" min="0" max="100" value={alerts.volume}
				aria-valuetext="{alerts.volume}%" oninput={(event) => alerts.setSettings({ volume: event.currentTarget.valueAsNumber })} />
			<output for="in-app-volume" class="w-9 text-right text-sm tabular-nums">{alerts.volume}%</output>
			<Button variant="outline" class="min-h-11" onclick={(event) => { if (event.isTrusted) void alerts.testSound(); }}>Test</Button>
		</div>
	</SettingsRow>
	<SettingsRow label="Show message text" hint="Turn off to hide alert text on a shared screen." for="in-app-message-text" control="auto">
		<Switch id="in-app-message-text" checked={!alerts.hideText} onchange={(on) => alerts.setSettings({ hideText: !on })} />
	</SettingsRow>
	<SettingsRow label="Do not disturb" hint="Pause pop-ups and sounds. The inbox still updates." control="auto">
		<DoNotDisturbMenu />
	</SettingsRow>
	<SettingsRow label="Tab title and icon count" hint="Use the same count as Needs you." for="in-app-tab-badge" control="auto">
		<Switch id="in-app-tab-badge" checked={alerts.tabTitleAndIconCount} onchange={(on) => alerts.setSettings({ tabTitleAndIconCount: on })} />
	</SettingsRow>
	<SettingsRow label="Muted" hint="Mute pop-ups, sound, and push on this device. Older computers may still send push." control="full">
		{#snippet below()}
			{#if mutes.length}
				<ul class="mb-2 grid divide-y divide-(--chat-border) rounded-lg border border-(--chat-border)">
					{#each mutes as mute (targetKey(mute.backendKey, mute.projectId))}
						<li class="flex items-center justify-between gap-2 px-2.5 py-1.5 text-sm">
							<span class="min-w-0"><strong class="block break-words font-semibold">{targetLabel(mute.backendKey, mute.projectId)}</strong><span class="text-xs text-muted-foreground">{quietUntilLabel(mute, notifications.muteClock)}</span></span>
							<Button variant="ghost" size="sm" class="min-h-11 shrink-0" onclick={() => unmute(mute.backendKey, mute.projectId)}>Unmute</Button>
						</li>
					{/each}
				</ul>
			{:else}<p class="mb-2 text-sm text-muted-foreground">Nothing is muted.</p>{/if}
			<div class="flex flex-wrap items-center gap-2 sm:flex-nowrap">
				<select aria-label="Project or computer to mute" class={selectClass} bind:value={target} disabled={!targets.length}>
					<option value="">Choose a project or computer</option>
					{#each targets as entry (targetKey(entry.backendId, entry.projectId))}
						<option value={targetKey(entry.backendId, entry.projectId)}>{targetLabel(entry.backendId, entry.projectId)}</option>
					{/each}
				</select>
				<select aria-label="How long to mute" class={selectClass + ' sm:max-w-48'} bind:value={duration}>
					{#each MUTE_DURATIONS as option (option.id)}<option value={option.id}>{option.label}</option>{/each}
				</select>
				<Button variant="outline" class="min-h-11" disabled={!selected} onclick={addMute}>Mute</Button>
			</div>
		{/snippet}
	</SettingsRow>
</SettingsGroup>
