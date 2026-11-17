<script lang="ts">
	import type { GraphPosition } from '../../task-graph.js';
	let { from, to }: { from: GraphPosition; to: GraphPosition } = $props();
	const distance = $derived(Math.hypot(to.x - from.x, to.y - from.y) || 1);
	const landing = $derived({ x: to.x - (to.x - from.x) / distance * to.radius, y: to.y - (to.y - from.y) / distance * to.radius });
</script>

<g class="report-cue" aria-hidden="true" pointer-events="none">
	<g transform="translate({from.x} {from.y})">
		<circle class="report-spark" r="4" style={`--report-x:${landing.x - from.x}px;--report-y:${landing.y - from.y}px`} />
	</g>
	<g transform="translate({to.x} {to.y})"><circle class="report-ring" r={to.radius + 8}/></g>
</g>

<style>
	.report-spark{fill:var(--task-status-working);opacity:0;animation:report-travel .65s ease-in-out both}
	.report-ring{fill:none;stroke:var(--task-status-working);stroke-width:2;opacity:0;animation:report-arrival .5s .65s ease-out both;transform-origin:0 0}
	@keyframes report-travel{0%{opacity:0;transform:translate(0,0) scale(.5)}15%{opacity:1}85%{opacity:1}100%{opacity:0;transform:translate(var(--report-x),var(--report-y)) scale(1)}}
	@keyframes report-arrival{0%{opacity:0;transform:scale(1)}15%{opacity:.8}100%{opacity:0;transform:scale(1.45)}}
	@media(prefers-reduced-motion:reduce){.report-cue{display:none}}
</style>
