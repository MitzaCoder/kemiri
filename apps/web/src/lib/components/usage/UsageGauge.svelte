<script lang="ts">
	import { arcPath, GAUGE_START_DEG, GAUGE_SWEEP_DEG, gaugeAngle, percentLabel, polar } from '#lib/subscription-usage.js';

	let { usedPercent, elapsedShare }: { usedPercent: number | null; elapsedShare: number | null } = $props();
	const center = 48;
	const usageRadius = 41;
	const timeRadius = 32;
	const end = GAUGE_START_DEG + GAUGE_SWEEP_DEG;
	const usageTrack = arcPath(center, center, usageRadius, GAUGE_START_DEG, end);
	const timeTrack = arcPath(center, center, timeRadius, GAUGE_START_DEG, end);
	const used = $derived(Math.min(100, Math.max(0, usedPercent ?? 0)));
	const timeAngle = $derived(gaugeAngle(elapsedShare ?? 0));
	const timeDot = $derived(polar(center, center, timeRadius, timeAngle));
	const notchStart = $derived(polar(center, center, usageRadius - 5, timeAngle));
	const notchEnd = $derived(polar(center, center, usageRadius + 5, timeAngle));
</script>

<div class="gauge" role="img" aria-label={`${usedPercent === null ? 'Usage unknown' : `${percentLabel(usedPercent)} used`}${elapsedShare === null ? '' : `, ${Math.round(elapsedShare * 100)}% of the window passed`}`}>
	<svg viewBox="0 0 96 96" fill="none" stroke-linecap="round" aria-hidden="true">
		<path d={usageTrack} stroke="var(--chat-surface-2)" stroke-width="7" />
		{#if used > 0}
			<path d={usageTrack} pathLength="100" stroke="var(--limit-tone)" stroke-width="7" stroke-dasharray="{used} 100" />
		{/if}
		<path d={timeTrack} stroke="var(--chat-border)" stroke-width="2" />
		{#if elapsedShare !== null}
			<path d={timeTrack} pathLength="100" stroke="var(--chat-fg-muted)" stroke-width="2" stroke-dasharray="{elapsedShare * 100} 100" />
			<circle cx={timeDot.x} cy={timeDot.y} r="2.7" fill="var(--chat-surface)" stroke="var(--chat-fg-muted)" stroke-width="1.4" />
			<line x1={notchStart.x} y1={notchStart.y} x2={notchEnd.x} y2={notchEnd.y} stroke="var(--chat-fg)" opacity=".72" />
		{/if}
	</svg>
	<div class="reading" aria-hidden="true"><strong>{percentLabel(usedPercent)}</strong><span>used</span></div>
	{#if elapsedShare !== null}<span class="elapsed" aria-hidden="true">{Math.round(elapsedShare * 100)}% of time</span>{/if}
</div>

<style>
	.gauge { position: relative; width: 5.25rem; aspect-ratio: 1; font-variant-numeric: tabular-nums; }
	.reading { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
	.reading strong { font-size: 1.15rem; line-height: 1.1; letter-spacing: -.04em; }
	.reading span, .elapsed { color: var(--chat-fg-muted); font-size: .625rem; }
	.elapsed { position: absolute; inset-inline: 0; bottom: 0; text-align: center; line-height: 1; }
</style>
