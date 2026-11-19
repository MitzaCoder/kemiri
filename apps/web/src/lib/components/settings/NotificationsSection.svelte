<script lang="ts">
	import { formatDateTime } from '#lib/time-format.ts';

	import SettingsFold from './SettingsFold.svelte';
	import SaveStatus from '#lib/components/settings/SaveStatus.svelte';
	import SendIcon from '@lucide/svelte/icons/send';
	import { onMount } from 'svelte';
	import Banner from '#lib/components/Banner.svelte';
	import AutoInput from '#lib/components/settings/AutoInput.svelte';
	import SettingsGroup from '#lib/components/settings/SettingsGroup.svelte';
	import SettingsRow from '#lib/components/settings/SettingsRow.svelte';
	import SettingsSection from '#lib/components/settings/SettingsSection.svelte';
	import StatusChip from '#lib/components/settings/StatusChip.svelte';
	import Switch from '#lib/components/settings/Switch.svelte';
	import { SaveState } from '#lib/save-state.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { harness } from '#lib/harness.svelte.js';
	import type { BackendNotificationView } from '#lib/notifications.js';
	import { notifications } from '#lib/notifications.svelte.js';
	import {
		NOTIFICATION_PRESET_CHOICES,
		NOTIFICATION_ALERT_GROUPS,
		notificationPreset,
		NOTIFICATION_KIND_INFO,
		kindsSummary,
		quietHoursDraft,
		quietHoursProblem
	} from '#lib/notifications.js';
	import { mutedProjectEntries, quietHoursSummary, type QuietHours } from '@kemiri/client';
	import { NOTIFICATION_PRESETS, type NotificationKind } from '@kemiri/protocol';

	/**
	 * Notifications for this browser: turn them on for the device, see what each backend knows about it, choose which
	 * events arrive, set quiet hours in the device's timezone, and mute a project. Preferences belong to this device and
	 * are pushed to every backend; a backend added later registers itself as soon as it connects.
	 */
	const backends = $derived(harness.backends);
	const settings = $derived(notifications.settings);
	const quiet = $derived(settings.quietHours);
	/** What quiet hours would read as, whether they are on or not. */
	const quietDraft = $derived(quietHoursDraft(settings, notifications.timezone));
	const quietProblem = $derived(quiet === null ? undefined : quietHoursProblem(quiet));
	const muted = $derived(mutedProjectEntries(settings));

	onMount(() => {
		harness.start();
		void notifications.start();
		void notifications.sync(harness.backends, { force: true });
	});

	function serverNamed(backendId: string): string {
		return harness.backend(backendId)?.name ?? backendId;
	}

	function projectNamed(backendId: string, projectId: string): string {
		const project = harness.backend(backendId)?.projects.find((entry) => entry.id === projectId);
		return project?.name ?? projectId;
	}

	async function enable(): Promise<void> {
		await notifications.enable(harness.backends);
	}

	async function disable(): Promise<void> {
		await notifications.disable(harness.backends);
	}

	async function toggleKind(kind: NotificationKind, on: boolean): Promise<void> {
		await notifications.setKind(harness.backends, kind, on);
	}

	const preset = $derived(notificationPreset(settings.kinds));
	const kindInfo = new Map(NOTIFICATION_KIND_INFO.map((info) => [info.kind, info]));

	function pickPreset(next: keyof typeof NOTIFICATION_PRESETS): void {
		void kindsSave.run(() => notifications.setKinds(harness.backends, NOTIFICATION_PRESETS[next]));
	}

	async function setQuietHours(patch: Partial<QuietHours>): Promise<void> {
		if (quiet === null) return;
		await notifications.setQuietHours(harness.backends, {
			...quiet,
			timezone: notifications.timezone,
			...patch
		});
	}

	async function toggleQuiet(on: boolean): Promise<void> {
		await notifications.setQuietHours(harness.backends, on ? { ...quietDraft, timezone: notifications.timezone } : null);
	}

	async function unmute(backendId: string, projectId: string): Promise<void> {
		await notifications.setProjectMuted(harness.backends, backendId, projectId, false);
	}

	const deviceSave = new SaveState();
	const kindsSave = new SaveState();
	const quietSave = new SaveState();

	const permissionNote = $derived.by(() => {
		if (notifications.permission === 'denied') {
			return 'The browser blocks notifications for this site. Allow them in the browser\'s site settings, then turn them on again.';
		}
		if (notifications.permission === 'unsupported') {
			return (
				'This browser cannot receive push notifications. ' +
				'On an iPhone, add the app to the Home Screen first; on Android, Chrome supports it.'
			);
		}
		if (backends.length === 0) return 'Add a computer first.';
		return undefined;
	});
	const deviceHint = $derived(
		notifications.enabled ? 'Push is on. See each computer’s state in Delivery details.' : 'Asks the browser for permission once.'
	);

	function toneOf(view: BackendNotificationView): 'ok' | 'warn' | 'err' | 'muted' {
		return view.tone === 'ok' ? 'ok' : view.tone === 'err' ? 'err' : view.tone === 'warn' ? 'warn' : 'muted';
	}
</script>

<SettingsSection title="Notifications" description="What reaches this device, and when" icon="bell">
	{#if notifications.error}
		<Banner tone="error">
			{notifications.error}
			{#if notifications.errorDetail}
				<p class="mt-1 text-xs text-muted-foreground">{notifications.errorDetail}</p>
			{/if}
		</Banner>
	{/if}
	{#if quietProblem}<Banner tone="warning">{quietProblem}</Banner>{/if}
	{#if permissionNote}
		<Banner tone={notifications.permission === 'denied' ? 'error' : 'info'}>
			{permissionNote}
			{#if backends.length === 0 && notifications.permission !== 'denied' && notifications.permission !== 'unsupported'}
				<a class="underline" href="/settings/backends">Computers</a>
			{/if}
		</Banner>
	{/if}

	<SettingsGroup title="This device">
		<SettingsRow
			label="Notifications on this device"
			hint={deviceHint}
			for="notifications-enabled"
			control="auto"
			status={deviceSave}
		>
			{#snippet learn()}
				Each computer pushes on its own, using its own subscription or sharing one with other computers.
				If a subscription changes, reopen the app while signed in.
				Device {notifications.settings.deviceId.slice(0, 8)} · {kindsSummary(settings)}.
			{/snippet}
			<div class="flex items-center gap-2">
				<StatusChip tone={notifications.enabled ? 'ok' : 'muted'}>{notifications.enabled ? 'On' : 'Off'}</StatusChip>
				<Switch
					id="notifications-enabled"
					checked={notifications.enabled}
					disabled={notifications.busy ||
						(!notifications.enabled && (notifications.permission === 'unsupported' || backends.length === 0))}
					onchange={(on) => void deviceSave.run(on ? enable : disable)}
				/>
			</div>
		</SettingsRow>
	</SettingsGroup>

	<SettingsGroup title="What to notify me about">
		<SettingsRow label="Alert preset" for="alert-preset">
			<select id="alert-preset" value={preset} disabled={notifications.busy}
				onchange={(event) => pickPreset(event.currentTarget.value as keyof typeof NOTIFICATION_PRESETS)}
				class="min-h-11 rounded-md border border-(--chat-border) bg-(--chat-bg) px-3 text-base">
				{#each NOTIFICATION_PRESET_CHOICES as option (option.value)}
					<option value={option.value}>{option.label}</option>
				{/each}
				{#if preset === 'custom'}<option value="custom" disabled>Custom</option>{/if}
			</select>
			<SaveStatus state={kindsSave} reserve={false} />
		</SettingsRow>
		<SettingsFold title="Choose individual alerts">
			{#each NOTIFICATION_ALERT_GROUPS as group (group.label)}
				<div class="divide-y divide-(--chat-border)">
					<h4 class="px-4 pt-3 text-sm font-semibold text-muted-foreground sm:px-5">{group.label}</h4>
					{#each group.kinds as kind (kind)}
						{@const info = kindInfo.get(kind)!}
						<SettingsRow label={info.label} hint={info.description} for="kind-{kind}" control="auto">
							<Switch id="kind-{kind}" checked={settings.kinds.includes(kind)} disabled={notifications.busy}
								onchange={(on) => void kindsSave.run(() => toggleKind(kind, on))} />
						</SettingsRow>
					{/each}
				</div>
			{/each}
			<div class="px-4 py-2 sm:px-5">
				<Button variant="outline" disabled={notifications.busy} onclick={() => pickPreset('important')}>Reset to defaults</Button>
			</div>
		</SettingsFold>
	</SettingsGroup>

	<SettingsGroup title="Quiet hours">
		<SettingsRow
			label="Be quiet at night"
			hint="Nothing is pushed in this window."
			for="quiet-enabled"
			control="auto"
			status={quietSave}
		>
			{#snippet learn()}
				Read on this device's clock ({notifications.timezone}). A window that crosses midnight is one window: 22:00 to
				07:00 is quiet overnight.
			{/snippet}
			<Switch
				id="quiet-enabled"
				checked={quiet !== null}
				disabled={notifications.busy}
				onchange={(on) => void quietSave.run(() => toggleQuiet(on))}
			/>
		</SettingsRow>
		{#if quiet}
			<SettingsRow label="From" hint="When the quiet window starts." for="quiet-start" control="auto">
				<AutoInput
					id="quiet-start"
					type="time"
					class="w-32"
					value={quiet.start}
					disabled={notifications.busy}
					commit={(value) => setQuietHours({ start: value })}
				/>
			</SettingsRow>
			<SettingsRow label="To" hint="When it ends." for="quiet-end" control="auto">
				<AutoInput
					id="quiet-end"
					type="time"
					class="w-32"
					value={quiet.end}
					disabled={notifications.busy}
					commit={(value) => setQuietHours({ end: value })}
				/>
			</SettingsRow>
			<SettingsRow
				label="Still notify failures"
				hint="A failed worker, schedule or deploy comes through anyway."
				for="quiet-failures"
				control="auto"
			>
				<Switch
					id="quiet-failures"
					checked={quiet.allowFailures}
					disabled={notifications.busy}
					onchange={(on) => void quietSave.run(() => setQuietHours({ allowFailures: on }))}
				/>
			</SettingsRow>
		{/if}
	</SettingsGroup>

	<SettingsGroup title="Muted projects" description="Mute one from the bell in the project's chat header.">
		{#each muted as entry (entry.backendKey + entry.projectId)}
			<div class="flex items-center gap-3 px-4 py-2.5 sm:px-5">
				<span class="min-w-0 flex-1 truncate text-sm">
					<span class="font-medium">{projectNamed(entry.backendKey, entry.projectId)}</span>
					<span class="text-muted-foreground"> · {serverNamed(entry.backendKey)}</span>
				</span>
				<Button variant="outline" class="max-sm:h-11" onclick={() => void unmute(entry.backendKey, entry.projectId)}>Unmute</Button>
			</div>
		{:else}
			<p class="px-5 py-4 text-sm text-muted-foreground">Nothing is muted.</p>
		{/each}
	</SettingsGroup>

	{#if backends.length > 0}
		<SettingsFold title="Delivery details">
		<SettingsGroup
			title="Computers"
			description="Each computer pushes on its own. If a subscription changes, reopen the app while signed in."
		>
			{#each backends as backend (backend.id)}
				{@const entry = notifications.backends[backend.id]}
				{@const view = notifications.viewFor(backend)}
				<SettingsRow label={backend.name} hint={view.detail ?? 'Registration and a test push.'} control="auto">
					{#snippet learn()}
						{#if entry?.device}
							Registered as “{entry.device.label}” since {formatDateTime(entry.device.createdAt)} · {entry
								.device.preferences.kinds.length} event kinds{entry.device.preferences.quietHours
								? ` · quiet ${quietHoursSummary(entry.device.preferences.quietHours)}`
								: ''}.
						{:else}
							This device is not registered here yet.
						{/if}
						{#if notifications.keyMismatchFor(entry) && entry?.publicKey}
							This computer's key: <code class="font-mono break-all">{entry.publicKey.slice(0, 16)}…</code>
						{/if}
					{/snippet}
					<div class="flex flex-wrap items-center gap-2 sm:justify-end">
						<StatusChip tone={toneOf(view)}>{view.label}</StatusChip>
						{#if view.status === 'key-mismatch'}
							<Button
								variant="outline"
								class="max-sm:h-11"
								disabled={!backend.ready || notifications.busy}
								onclick={() => void notifications.enableBackend(backend, true)}
							>
								Re-subscribe
							</Button>
						{:else if view.status === 'off' || view.status === 'failed'}
							<Button
								variant="outline"
								class="max-sm:h-11"
								disabled={!backend.ready || notifications.busy || notifications.permission === 'unsupported'}
								onclick={() => void notifications.enableBackend(backend)}
							>
								Enable push
							</Button>
						{:else if view.status === 'sync-needed'}
							<Button
								variant="outline"
								class="max-sm:h-11"
								disabled={!backend.ready || notifications.busy}
								onclick={() => void notifications.sync(harness.backends, { force: true })}
							>
								Sync
							</Button>
						{/if}
						{#if notifications.push[backend.id]?.enabled}
							<Button
								variant="ghost"
								class="max-sm:h-11"
								disabled={!backend.ready || notifications.busy}
								onclick={() => void notifications.disableBackend(backend)}
							>
								Disable push
							</Button>
						{/if}
						<Button
							variant="outline"
							class="max-sm:h-11"
							disabled={entry?.device == null || entry?.testing === true || notifications.busy}
							onclick={() => void notifications.test(backend)}
						>
							{#if entry?.testing}<Spinner data-icon="inline-start" />{:else}<SendIcon data-icon="inline-start" />{/if}
							Send a test
						</Button>
					</div>
					{#if entry?.test}
						<p class="text-xs {entry.test.ok ? 'text-(--chat-success)' : 'text-destructive'}" role="status">{entry.test.text}</p>
					{/if}
					{#if entry?.error}<p class="text-xs text-destructive" role="alert">{entry.error}</p>{/if}
				</SettingsRow>
			{/each}
		</SettingsGroup>
		</SettingsFold>
	{/if}

</SettingsSection>
