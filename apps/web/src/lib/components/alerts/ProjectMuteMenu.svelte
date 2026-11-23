<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import BellOffIcon from '@lucide/svelte/icons/bell-off';
	import { MUTE_DURATIONS, projectMuteMenuState, quietPeriod, type MuteDuration } from '#lib/alert-quiet.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import { harness } from '#lib/harness.svelte.js';
	import { notifications } from '#lib/notifications.svelte.js';

	let { backendId, projectId, projectName }: { backendId: string; projectId: string; projectName: string } = $props();
	const state = $derived(projectMuteMenuState(notifications.settings, backendId, projectId, notifications.muteClock));
	const statusId = $props.id();
	const itemClass = 'flex min-h-11 cursor-pointer items-center rounded-lg px-2.5 text-sm outline-none data-highlighted:bg-(--chat-surface-2)';

	function muteProject(duration: MuteDuration | null): void {
		void notifications.setProjectMute(harness.backends, backendId, projectId, duration === null ? null : quietPeriod(duration, Date.now()));
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		class={buttonVariants({ variant: 'ghost', size: 'icon-sm', class: 'size-11 shrink-0 data-[muted=true]:bg-(--accent-2)/15 data-[muted=true]:text-(--accent-2)' })}
		aria-label="Mute notifications for {projectName}" aria-describedby={state.kind !== 'none' ? statusId : undefined}
		title={state.kind === 'none' ? `Mute notifications for ${projectName}` : state.status}
		data-muted={state.kind !== 'none'}>
		<BellOffIcon aria-hidden="true" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal>
		<DropdownMenu.Content align="end" sideOffset={5}
			class="z-[75] w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-(--chat-border) bg-(--chat-surface) p-1 text-(--chat-fg) shadow-xl">
			<DropdownMenu.Group>
				{#if state.kind === 'none'}
					{#each MUTE_DURATIONS as duration (duration.id)}
						<DropdownMenu.Item class={itemClass} onSelect={() => muteProject(duration.id)}>
							Mute {projectName} {duration.id === 'indefinite' ? 'until I turn it back on' : duration.label.toLowerCase()}
						</DropdownMenu.Item>
					{/each}
				{:else}
					<DropdownMenu.GroupHeading class="px-2.5 py-1.5 text-xs font-semibold text-(--chat-fg-muted)">{state.status}</DropdownMenu.GroupHeading>
					<DropdownMenu.Item class={itemClass} onSelect={() => muteProject(null)}>Unmute</DropdownMenu.Item>
				{/if}
			</DropdownMenu.Group>
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
{#if state.kind !== 'none'}<span id={statusId} class="sr-only">{state.status}</span>{/if}
