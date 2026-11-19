<script lang="ts">
	import type { BoardLiveLine } from '@kemiri/protocol';
	import { activityMinute } from '#lib/activity-minute.js';
	import { exactTime, relativeTime } from '#lib/relative-time.js';

	let { line, arrived = false }: { line: BoardLiveLine; arrived?: boolean } = $props();
</script>

<li class="live-line" class:arrived data-live-line={line.id} data-kind={line.kind}>
	<p class="live-line-context">
		<span class="live-line-kind">{line.kind === 'fact' ? 'Recorded' : line.kind === 'result' ? 'Result' : 'Phase'}</span>
		<span>{line.actor.name}</span>
		<time datetime={line.at} title={exactTime(line.at)}>{relativeTime(line.at, $activityMinute)}</time>
	</p>
	<p class="live-line-text">{line.text}</p>
</li>

<style>
	.live-line { padding: 0.375rem 0.625rem; border-inline-start: 2px solid var(--chat-border); overflow-wrap: anywhere; }
	.live-line[data-kind='result'] { border-inline-start-color: var(--chat-success); }
	.live-line[data-kind='fact'] { border-inline-start-style: dashed; border-inline-start-color: var(--chat-fg-muted); }
	.live-line[data-kind='fact'] .live-line-text { color: var(--chat-fg); }
	.live-line-context { display: flex; flex-wrap: wrap; gap: 0.125rem 0.625rem; font-size: 0.75rem; color: var(--chat-fg-muted); }
	.live-line-kind { font-weight: 600; }
	.live-line-text { font-size: 0.875rem; color: var(--chat-fg-muted); }
	.live-line[data-kind='result'] .live-line-text { color: var(--chat-fg); font-weight: 500; }
	@media (prefers-reduced-motion: no-preference) {
		.arrived { animation: live-arrival 1.4s ease-out; }
		@keyframes live-arrival { from { background: var(--chat-surface-2); } to { background: transparent; } }
	}
</style>
