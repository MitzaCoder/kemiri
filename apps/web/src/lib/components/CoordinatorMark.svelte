<script lang="ts">
	import type { ThreadSummary } from '@kemiri/protocol';
	import { coordinatorColor, coordinatorMark } from '#lib/coordinators.js';
	let { thread }: { thread: ThreadSummary } = $props();
</script>
<span class="coordinator-mark" style:--coordinator-color={coordinatorColor(thread)} title={thread.title} aria-hidden="true">{coordinatorMark(thread.title)}</span>
<style>
	.coordinator-mark { display:inline-grid; place-items:center; width:1.35rem; height:1.35rem; flex:none; border-radius:.4rem; font-size:.7rem; font-weight:750; background:color-mix(in srgb,var(--coordinator-color) 22%,var(--chat-bg)); color:color-mix(in srgb,var(--coordinator-color) 62%,var(--chat-fg)); }
</style>
