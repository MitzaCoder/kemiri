<script lang="ts">
	import '../mascot-motion.css';
	import { graphMascotSvg, graphMascotViewBox } from '../../generated/graph-mascot.js';
	import type { WorkerMotion } from '../../worker-motion.js';

	let {
		state, size = 30, zoom = 1, backgroundJob = false, looping = false, reducedMotion = false,
		still = false, delayMs = 0, play = false, gradientPrefix = 'graph-mascot',
	}: {
		state: WorkerMotion; size?: number; zoom?: number; backgroundJob?: boolean; looping?: boolean;
		reducedMotion?: boolean; still?: boolean; delayMs?: number; play?: boolean; gradientPrefix?: string;
	} = $props();
	const svg = $derived(graphMascotSvg(gradientPrefix));
	const renderedSize = $derived(size * (backgroundJob ? 1.25 : 1));
	const screenSize = $derived(renderedSize * zoom);
</script>

<!-- Decorative inside a labelled, focusable graph node. Definitions live in GraphMascotDefs. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox={graphMascotViewBox} width={renderedSize} height={renderedSize}
	fill="none" class="mascot-motion graph-mascot" aria-hidden="true"
	data-state={state === 'waiting' ? 'thinking' : state} data-size={screenSize <= 32 ? 'small' : undefined}
	data-looping={looping && !reducedMotion && !still} data-motion-still={reducedMotion || still}
	data-sleep-z={screenSize >= 28} data-play={play && !reducedMotion && !still ? '' : undefined}
	style={`--mascot-delay:${delayMs}ms`}>
	{#if backgroundJob}
		<circle cx="512" cy="505" r="365" fill="none" stroke="currentColor" stroke-opacity=".5" stroke-width="18" stroke-dasharray="34 24" />
	{/if}
	{@html svg.geometry}
	{#if state === 'sleeping' && screenSize >= 28}
		<text class="mascot-sleep-z" x="700" y="330" fill="currentColor" font-size="190" font-weight="700" font-family="ui-sans-serif,system-ui,sans-serif">z</text>
	{/if}
	{#if state === 'waiting' || state === 'failed' || state === 'done'}
		<g class="graph-mascot-badge">
			<circle cx="780" cy="290" r="110" fill={state === 'waiting' ? '#d97706' : state === 'failed' ? '#e11d48' : '#059669'} stroke="white" stroke-width="22" />
			{#if state === 'done'}
				<path d="M728 292l36 36 68-76" fill="none" stroke="white" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" />
			{:else}
				<text x="780" y="355" text-anchor="middle" fill="white" font-size="185" font-weight="800" font-family="ui-sans-serif,system-ui,sans-serif">{state === 'waiting' ? '?' : '!'}</text>
			{/if}
		</g>
	{/if}
</svg>
