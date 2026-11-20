<script lang="ts">
 import TimeInput from "#lib/components/TimeInput.svelte";
 import { timeFormat, setTimeFormat, TIME_FORMAT_OPTIONS, type TimeFormat } from "#lib/time-format.ts";
	import { workDay } from '#lib/work-day.svelte.js';
	import CheckIcon from '@lucide/svelte/icons/check';
	import Segmented from './Segmented.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { colorScheme } from '#lib/themes/color-scheme.svelte.js';
	import { parseColorScheme } from '#lib/themes/color-scheme.js';
	import { codeWrap } from '#lib/code-wrap.svelte.js';
	import { timelineOrder } from '#lib/timeline-order.svelte.js';
	import { mediaDisplay } from '#lib/media-display.svelte.js';
	import SettingsGroup from '#lib/components/settings/SettingsGroup.svelte';
	import SettingsRow from '#lib/components/settings/SettingsRow.svelte';
	import SettingsSection from '#lib/components/settings/SettingsSection.svelte';
	import ThemePreview from '#lib/components/settings/ThemePreview.svelte';
	import { theme } from '#lib/themes/theme.svelte.js';
	import { THEMES } from '#lib/themes/themes.js';
	import { TASK_VIEW_DESIGNS } from '#lib/task-view/designs.js';
	import { taskViewDesignPreference } from '#lib/task-view/preference.svelte.js';

	const schemeOptions = [
		{ value: 'device', label: 'Device' },
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' }
	];

	function resetReadingChoices(): void {
		codeWrap.reset();
		timelineOrder.reset();
		mediaDisplay.setSeparate(false);
	}

	function onkeydown(event: KeyboardEvent): void {
		const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
		const step = keys[event.key];
		if (step === undefined) return;
		event.preventDefault();
		const at = THEMES.findIndex((entry) => entry.id === theme.current);
		const next = THEMES[(at + step + THEMES.length) % THEMES.length];
		if (next === undefined) return;
		theme.set(next.id);
		queueMicrotask(() =>
			(event.currentTarget as HTMLElement).querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
		);
	}
</script>

<SettingsSection title="Appearance" description="How the app looks in this browser." icon="palette">
	<SettingsGroup title="Theme">
		<div class="px-4 py-4 sm:px-5">
			<div
				role="radiogroup"
				aria-label="Theme"
				tabindex="-1"
				{onkeydown}
				class="grid gap-3 sm:grid-cols-2"
			>
				{#each THEMES as entry (entry.id)}
					{@const chosen = theme.current === entry.id}
					<button
						type="button"
						role="radio"
						aria-checked={chosen}
						tabindex={chosen ? 0 : -1}
						data-theme-card={entry.id}
						onclick={() => theme.set(entry.id)}
						class="group flex flex-col overflow-hidden rounded-xl text-left outline-none transition-[box-shadow,transform] focus-visible:ring-3 focus-visible:ring-ring/50 motion-safe:hover:-translate-y-px {chosen
							? 'shadow-md ring-2 ring-(--accent-2)'
							: 'shadow-xs ring-1 ring-foreground/15 hover:shadow-md hover:ring-foreground/30'}"
					>
						<div class="grid grid-cols-2">
							<ThemePreview id={entry.id} />
							<ThemePreview id={entry.id} dark />
						</div>
						<div class="flex items-center gap-2 border-t border-(--chat-border) bg-card px-3 py-2.5">
							<span class="flex min-w-0 flex-1 flex-col">
								<span class="text-sm font-semibold">{entry.name}</span>
								<span class="truncate text-xs text-muted-foreground">{entry.description}</span>
							</span>
							<span
								class="grid size-5 shrink-0 place-items-center rounded-full {chosen
									? 'bg-primary text-primary-foreground'
									: 'ring-1 ring-foreground/20'}"
							>
								{#if chosen}<CheckIcon class="size-3" aria-hidden="true" />{/if}
							</span>
						</div>
					</button>
				{/each}
			</div>
		</div>
		<SettingsRow label="Light or dark" hint="Device follows this device’s appearance.">
			<Segmented label="Light or dark" options={schemeOptions} value={colorScheme.preference} onchange={(next) => colorScheme.set(parseColorScheme(next))} />
		</SettingsRow>
	</SettingsGroup>
	<SettingsGroup title="Tasks">
		<SettingsRow label="Task view" chip="This device only" for="task-view-design">
			<select id="task-view-design" value={taskViewDesignPreference.current.id} onchange={(event) => taskViewDesignPreference.set(event.currentTarget.value)} class="min-h-11 rounded-md border border-(--chat-border) bg-(--chat-bg) px-3 text-base">
				{#each TASK_VIEW_DESIGNS as design (design.id)}<option value={design.id}>{design.label}</option>{/each}
			</select>
		</SettingsRow>
	</SettingsGroup>
	<SettingsGroup title="Time">
		<SettingsRow label="Time format" hint="Automatic follows your browser locale. Saved in this browser.">
			<select aria-label="Time format" value={timeFormat.current} onchange={(event) => setTimeFormat(event.currentTarget.value as TimeFormat)} class="min-h-11 rounded-md border border-(--chat-border) bg-(--chat-bg) px-3 text-base">
				{#each TIME_FORMAT_OPTIONS as option}<option value={option.value}>{option.label}</option>{/each}
			</select>
		</SettingsRow>
	</SettingsGroup>
	<SettingsGroup title="Waiting tasks">
		<SettingsRow label="Waiting tasks come back at" term="Work day start" hint="A task waiting until a date returns at this time, in this device's time zone.">
			<TimeInput aria-label="Waiting tasks come back at" value={workDay.start} onchange={(value) => workDay.set(value)} />
		</SettingsRow>
	</SettingsGroup>
	<SettingsGroup title="Reading">
		<SettingsRow label="Wrap code" control="auto">
			<span class="text-sm text-muted-foreground">{codeWrap.preference === 'wrap' ? 'Wrap lines' : codeWrap.preference === 'scroll' ? 'Scroll sideways' : 'Automatic'}</span>
		</SettingsRow>
		<SettingsRow label="Timeline order" control="auto">
			<span class="text-sm text-muted-foreground">{timelineOrder.order === 'newest' ? 'Newest first' : 'Oldest first'}</span>
		</SettingsRow>
		<SettingsRow label="Image compare" control="auto">
			<span class="text-sm text-muted-foreground">{mediaDisplay.separate ? 'Show singly' : 'Compare pairs'}</span>
		</SettingsRow>
		<div class="px-4 py-3 sm:px-5"><Button variant="outline" onclick={resetReadingChoices}>Reset reading choices</Button></div>
	</SettingsGroup>
	<p class="px-1 text-xs text-(--chat-fg-subtle)">These choices are kept in this browser.</p>
</SettingsSection>
