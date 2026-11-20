<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import CheckIcon from '@lucide/svelte/icons/check';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import { tick } from 'svelte';
	import { buttonVariants } from '#lib/components/ui/button/index.js';
	import { TASK_VIEW_DESIGNS } from '#lib/task-view/designs.js';
	import { taskViewDesignPreference } from '#lib/task-view/preference.svelte.js';

	let trigger = $state<HTMLButtonElement | null>(null);
	const sheet = $derived(trigger?.closest<HTMLElement>('[data-task-sheet]'));

	async function selectDesign(id: string): Promise<void> {
		const changed = id !== taskViewDesignPreference.current.id;
		const openedSheet = sheet;
		taskViewDesignPreference.set(id);
		if (changed && openedSheet) {
			// The old trigger unmounts with the design. Restore focus in the new one.
			await tick();
			(openedSheet.querySelector<HTMLElement>('[data-task-view-design-trigger]') ?? openedSheet).focus();
		}
	}
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger bind:ref={trigger} class={buttonVariants({ variant: 'ghost', size: 'icon-sm', class: 'size-11' })}
		aria-label="More" title="More" data-task-view-design-trigger>
		<EllipsisIcon />
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal to={sheet ?? undefined}>
		<DropdownMenu.Content sideOffset={6} align="end" class="z-[100] max-h-[70dvh] w-56 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-(--chat-border) bg-(--chat-surface) p-1 text-(--chat-fg) shadow-xl">
			<DropdownMenu.RadioGroup aria-label="Task view" value={taskViewDesignPreference.current.id} onValueChange={selectDesign}>
				<DropdownMenu.GroupHeading class="px-2.5 py-1.5 text-xs font-semibold text-(--chat-fg-muted)">Task view</DropdownMenu.GroupHeading>
				{#each TASK_VIEW_DESIGNS as design (design.id)}
					<DropdownMenu.RadioItem value={design.id} class="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg p-2.5 outline-none data-highlighted:bg-(--chat-surface-2)">
						<span class="grid size-4 shrink-0 place-items-center" aria-hidden="true">
							{#if design.id === taskViewDesignPreference.current.id}<CheckIcon class="size-4" />{/if}
						</span>
						<span><span class="block text-sm font-medium">{design.label}</span><span class="block text-xs text-(--chat-fg-subtle)">{design.description}</span></span>
					</DropdownMenu.RadioItem>
				{/each}
			</DropdownMenu.RadioGroup>
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
