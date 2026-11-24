<script lang="ts">
	import type { ThreadSummary } from '@kemiri/protocol';
	import { coordinatorColor, coordinatorMark } from '#lib/coordinators.js';
	let { thread, compact = false }: { thread: ThreadSummary; compact?: boolean } = $props();
</script>
<span class="coordinator-mark" class:compact style:--coordinator-color={coordinatorColor(thread)} title={thread.title} aria-hidden="true">{coordinatorMark(thread.title)}</span>
<style>
	.coordinator-mark { display:inline-grid; place-items:center; width:1.35rem; height:1.35rem; flex:none; border-radius:.4rem; font-size:.7rem; font-weight:750; background:color-mix(in srgb,var(--coordinator-color) 22%,var(--chat-bg)); color:color-mix(in srgb,var(--coordinator-color) 62%,var(--chat-fg)); }
	.compact { width:.875rem; height:.875rem; border-radius:.25rem; font-size:.5625rem; line-height:1; }
</style>
