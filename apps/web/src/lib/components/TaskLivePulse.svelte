<script lang="ts">
 import type { BoardLivePulse } from '@kemiri/protocol';
 import { pulseElapsed } from '#lib/task-live.js';

 let { pulse }: { pulse: BoardLivePulse } = $props();
 let now = $state(Date.now());
 const elapsed = $derived(pulseElapsed(pulse.since, now));
 $effect(() => {
  const timer = setInterval(() => { now = Date.now(); }, 1000);
  return () => clearInterval(timer);
 });
</script>

<p class="live-pulse" aria-label="Run pulse">
 <span class="live-pulse-dot" aria-hidden="true"></span>
 <span>{pulse.label}{#if pulse.tool}<span class="live-pulse-detail"> · {pulse.tool}</span>{/if}</span>
 {#if elapsed}<time class="live-pulse-detail" datetime={pulse.since}>· {elapsed}</time>{/if}
</p>

<style>
 .live-pulse { display: flex; flex-wrap: wrap; align-items: center; gap: 0.125rem 0.375rem; font-size: 0.8125rem; }
 .live-pulse-dot { width: 0.375rem; height: 0.375rem; border-radius: 50%; background: currentColor; }
 .live-pulse-detail { color: var(--chat-fg-muted); font-size: 0.75rem; font-variant-numeric: tabular-nums; }
</style>
