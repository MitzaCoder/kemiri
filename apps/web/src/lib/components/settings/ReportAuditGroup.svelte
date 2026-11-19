<script lang="ts">
	import { onMount } from 'svelte';
	import { DEFAULT_REPORT_AUDIT, DEFAULT_TASK_WATCHER, type ReportAuditSettings } from '@kemiri/protocol';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import { modelKey, modelOptions } from '#lib/models.js';
	import { withoutWorkerOnly } from '#lib/official-agents.js';
	import { parseReportAuditBudget, reportAuditStatusLines, reportAuditSupported } from '#lib/report-audit.js';
	import { exactTime } from '#lib/relative-time.js';
	import { SaveState } from '#lib/save-state.svelte.js';
	import AutoInput from './AutoInput.svelte';
	import Combobox from './Combobox.svelte';
	import SettingsGroup from './SettingsGroup.svelte';
	import SettingsRow from './SettingsRow.svelte';

	let { backend, projectId, watcher = false }: { backend: BackendConnection; projectId: string; watcher?: boolean } = $props();
	const project = $derived(backend.projects.find(entry => entry.id === projectId));
	const settings = $derived(watcher ? project?.taskWatcher ?? DEFAULT_TASK_WATCHER : project?.reportAudit ?? DEFAULT_REPORT_AUDIT);
	const supported = $derived(watcher ? backend.supports('task-live') && backend.supports('task-live-watcher') : reportAuditSupported(backend.connection.features));
	const prefix = $derived(watcher ? 'task-watcher' : 'report-audit');
	const status = $derived(watcher ? project?.taskWatcherStatus : project?.reportAuditStatus);
	const options = $derived(modelOptions(withoutWorkerOnly(backend.models), backend.providers));
	let pendingMode = $state<ReportAuditSettings['mode'] | undefined>(undefined);
	let pendingModel = $state<string | undefined>(undefined);
	let busy = $state(false);
	let now = $state(Date.now());
	const save = new SaveState();
	const mode = $derived(pendingMode ?? settings.mode);
	const model = $derived(pendingModel ?? (settings.model ? modelKey(settings.model) : ''));
	const statusLines = $derived(watcher ? settings.mode === 'auto' ? ['Uses recorded steps without a model.'] : settings.mode === 'off' ? ['Live news lines are disabled.'] : [status?.reason ?? 'Uses the chosen model to pick from recorded actions.', `${status?.tokensUsed ?? 0} of ${settings.dailyTokens.toLocaleString()} tokens today.`] : reportAuditStatusLines(status, settings.dailyTokens, backend.models, backend.providers, now));
	const modeOptions = $derived([
		{ value: 'auto', label: 'Automatic', description: watcher ? 'Uses recorded steps, without a model. The default.' : 'Uses an available small model. The default.' },
		{ value: 'off', label: 'Off', description: watcher ? 'Do not write live news lines.' : 'Do not check reports with a model.' },
		{ value: 'model', label: 'Choose a model', description: watcher ? 'Use a small model to select a recorded action.' : 'Use a specific model from this backend.' }
	]);
	onMount(() => {
		const timer = setInterval(() => { now = Date.now(); }, 30_000);
		return () => clearInterval(timer);
	});

	async function saveChoice(next: ReportAuditSettings): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			if (await save.run(() => backend.configureProject(projectId, watcher ? { taskWatcher: next } : { reportAudit: next }))) {
				pendingMode = undefined;
				pendingModel = undefined;
			}
		} finally { busy = false; }
	}

	function pickMode(next: string): void {
		pendingMode = next as ReportAuditSettings['mode'];
		save.reset();
		if (next === 'model' && !settings.model) return;
		void saveChoice({ ...settings, mode: pendingMode });
	}

	function pickModel(key: string): void {
		const chosen = backend.models.find(entry => modelKey(entry) === key);
		if (!chosen) return;
		pendingModel = key;
		void saveChoice({ ...settings, mode: 'model', model: { provider: chosen.provider, modelId: chosen.modelId } });
	}

	async function saveBudget(text: string): Promise<void> {
		const dailyTokens = parseReportAuditBudget(text);
		if (dailyTokens === undefined) throw new Error('Enter a whole number from 0 to 10,000,000.');
		busy = true;
		try { await backend.configureProject(projectId, watcher ? { taskWatcher: { ...settings, dailyTokens } } : { reportAudit: { ...settings, dailyTokens } }); }
		finally { busy = false; }
	}
</script>

{#if supported}
	<SettingsGroup title={watcher ? 'Live news lines' : 'Report check'} description={watcher ? 'Short updates from the work log, marked auto. They stay in Live and do not change the task report.' : 'Checks active task reports once an hour and asks the main chat to fill in anything missing.'}>
		<SettingsRow label="Mode" hint={watcher ? "Automatic picks from recorded tool steps without sending them to a model." : "Automatic uses a signed-in small model: Claude Haiku 5.5, then GPT-5 nano, then a small ChatGPT model."} for={`${prefix}-mode`} status={save} onretry={() => mode === 'model' ? pickModel(model) : pickMode(mode)}>
			<Combobox id={`${prefix}-mode`} options={modeOptions} value={mode} onchange={pickMode} disabled={busy} invalid={save.status === 'failed'} />
		</SettingsRow>
		{#if mode === 'model'}
			<SettingsRow label={watcher ? 'Live news model' : 'Report check model'} hint={settings.mode === 'model' ? 'The daily token limit still applies.' : 'Choose a model to save this mode. The daily token limit still applies.'} for={`${prefix}-model`}>
				<Combobox id={`${prefix}-model`} {options} value={model} onchange={pickModel} placeholder={backend.modelsLoaded ? 'Choose a model…' : 'Loading models…'} searchPlaceholder="Search models or providers…" disabled={busy || !backend.modelsLoaded} invalid={save.status === 'failed'} />
			</SettingsRow>
		{/if}
		{#if !watcher || mode === 'model'}
		<SettingsRow label="Daily token budget" hint="Resets at midnight UTC. Includes input and output tokens; 0 prevents calls. Saves on Enter or when you leave the field." for={`${prefix}-budget`} control="auto">
			<AutoInput id={`${prefix}-budget`} type="number" min={0} max={10_000_000} step={1} value={String(settings.dailyTokens)} class="w-36" disabled={busy} commit={saveBudget} />
		</SettingsRow>
		{/if}
		<div class="flex flex-col gap-1 px-4 py-3 text-[0.8125rem] text-(--chat-fg-subtle) sm:px-5" role="status" aria-live="polite" title={status?.lastRunAt ? exactTime(status.lastRunAt) : undefined}>
			{#each statusLines as line}<p>{line}</p>{/each}
		</div>
	</SettingsGroup>
{/if}
