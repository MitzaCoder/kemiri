<script lang="ts">
	import BellIcon from '@lucide/svelte/icons/bell';
	import BellOffIcon from '@lucide/svelte/icons/bell-off';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { MUTE_DURATIONS, quietPeriod, type MuteDuration, type ProjectMuteMenuState } from '#lib/alert-quiet.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { harness } from '#lib/harness.svelte.js';
	import { notifications } from '#lib/notifications.svelte.js';

	let { backendId, projectId, mute, onpick }: { backendId: string; projectId: string; mute: ProjectMuteMenuState; onpick: () => void } = $props();
	let expanded = $state(false);
	const durationsId = $props.id();

	function muteProject(duration: MuteDuration | null): void {
		void notifications.setProjectMute(harness.backends, backendId, projectId, duration === null ? null : quietPeriod(duration, Date.now()));
		onpick();
	}
</script>

{#if mute.kind === 'none'}
	<Button variant="ghost" size="sm" class="h-8 w-full justify-start gap-2 px-2 font-normal"
		aria-expanded={expanded} aria-controls={durationsId} onclick={() => expanded = !expanded}>
		<BellIcon class="size-4" /> Mute notifications… <ChevronDownIcon class="ml-auto size-3.5" />
	</Button>
	<div id={durationsId} hidden={!expanded} class="border-l border-(--chat-border) ml-4 pl-2">
		{#each MUTE_DURATIONS as duration (duration.id)}
			<Button variant="ghost" size="sm" class="w-full justify-start font-normal" onclick={() => muteProject(duration.id)}>
				{duration.id === 'indefinite' ? 'Until I turn it back on' : duration.label}
			</Button>
		{/each}
	</div>
{:else}
	<Button variant="ghost" size="sm" class="h-8 w-full justify-start gap-2 px-2 font-normal" title={mute.status} onclick={() => muteProject(null)}>
		<BellOffIcon class="size-4" /> Unmute notifications
	</Button>
	<p class="px-2 pb-1 text-xs text-(--chat-fg-subtle)">{mute.status}</p>
{/if}
