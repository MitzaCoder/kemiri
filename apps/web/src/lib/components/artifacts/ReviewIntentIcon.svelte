<script lang="ts">
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PanelsTopLeftIcon from '@lucide/svelte/icons/panels-top-left';
	import ScissorsIcon from '@lucide/svelte/icons/scissors';
	import CheckIcon from '@lucide/svelte/icons/check';
	import type { ReviewIntent } from '#lib/artifact-review.js';
	let { intent }: { intent?: ReviewIntent } = $props();
	const icons = { Clarify: CircleHelpIcon, Change: PencilIcon, 'Show differently': PanelsTopLeftIcon, Cut: ScissorsIcon, Keep: CheckIcon };
	const Icon = $derived(intent && icons[intent]);
</script>

{#if Icon}<Icon size={13} aria-hidden="true" />{/if}
