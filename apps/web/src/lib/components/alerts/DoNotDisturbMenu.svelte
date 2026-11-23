<script lang="ts">
	import { DropdownMenu } from 'bits-ui';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { alerts } from '#lib/alerts.svelte.js';
	import { DO_NOT_DISTURB_DURATIONS, quietPeriod, quietUntilLabel } from '#lib/alert-quiet.js';
	import { buttonVariants } from '#lib/components/ui/button/index.js';

	let { inInbox = false, portal }: { inInbox?: boolean; portal?: HTMLElement | null } = $props();
	const status = $derived(alerts.doNotDisturb ? quietUntilLabel(alerts.doNotDisturb, Date.now(), 'Until turned off') : 'Off');
	const itemClass = 'flex min-h-11 cursor-pointer items-center rounded-lg px-2.5 text-sm outline-none data-highlighted:bg-(--chat-surface-2)';
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger class={buttonVariants({ variant: inInbox ? 'ghost' : 'outline', size: 'sm', class: 'min-h-11' })}
		aria-label={alerts.doNotDisturb ? 'Do not disturb, on' : 'Do not disturb'} title={status}>
		<MoonIcon size={15} aria-hidden="true" />
		<span>{inInbox ? 'Do not disturb' : status}</span>
		<ChevronDownIcon size={13} aria-hidden="true" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Portal to={portal ?? undefined}>
		<DropdownMenu.Content align="end" sideOffset={5}
			class="z-[75] w-60 max-w-[calc(100vw-1rem)] rounded-xl border border-(--chat-border) bg-(--chat-surface) p-1 text-(--chat-fg) shadow-xl">
			<DropdownMenu.Group>
				<DropdownMenu.GroupHeading class="px-2.5 py-1.5 text-xs font-semibold text-(--chat-fg-muted)">Do not disturb</DropdownMenu.GroupHeading>
				{#each DO_NOT_DISTURB_DURATIONS as duration (duration.id)}
					<DropdownMenu.Item class={itemClass} onSelect={() => alerts.setSettings({ doNotDisturb: quietPeriod(duration.id, Date.now()) })}>{duration.label}</DropdownMenu.Item>
				{/each}
				{#if alerts.doNotDisturb}
					<DropdownMenu.Item class={itemClass} onSelect={() => alerts.setSettings({ doNotDisturb: null })}>Turn off Do not disturb</DropdownMenu.Item>
				{/if}
			</DropdownMenu.Group>
		</DropdownMenu.Content>
	</DropdownMenu.Portal>
</DropdownMenu.Root>
