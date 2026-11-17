<script lang="ts">
	import type { GraphNode } from '../../task-graph.js';
	import type { WorkerMotion, WorkerMotionAllowance } from '../../worker-motion.js';
	import GraphMascot from './GraphMascot.svelte';
	let { node, state: motion, allowance, zoom, reduced, departing = false, gradientPrefix }: {
		node: GraphNode; state: WorkerMotion; allowance: WorkerMotionAllowance; zoom: number;
		reduced: boolean; departing?: boolean; gradientPrefix: string;
	} = $props();
	let previous: WorkerMotion | undefined;
	let playFailure = $state(false);
	$effect(() => {
		const next = motion;
		if (reduced || allowance.still) playFailure = false;
		else if (previous !== undefined && previous !== 'failed' && next === 'failed') playFailure = true;
		else if (next !== 'failed') playFailure = false;
		previous = next;
	});
	const backgroundJob = $derived(node.kind === 'thread');
	const size = 60;
	const renderedSize = $derived(size * (backgroundJob ? 1.25 : 1));
</script>

<g class="graph-crew" class:departing class:stopped={node.status === 'stopped'}
	data-crew-motion={departing ? 'done' : motion} data-crew-looping={allowance.looping}
	data-still={reduced || allowance.still}>
	<circle class="crew-focus" r={renderedSize / 2 + 2} />
	<g transform="translate({-renderedSize / 2} {-renderedSize / 2})">
		<GraphMascot state={departing ? 'done' : motion} {size} {backgroundJob} {zoom}
			looping={allowance.looping && !departing} reducedMotion={reduced} still={allowance.still}
			delayMs={allowance.delayMs} play={departing ? node.status !== 'stopped' : playFailure} {gradientPrefix}/>
	</g>
</g>

<style>
	.crew-focus{fill:transparent;stroke:none}
	:global(a:focus-visible) .crew-focus{stroke:var(--chat-fg);stroke-width:2;stroke-dasharray:3 3}
	.departing{pointer-events:none;animation:crew-leave 1.7s linear both}
	.departing.stopped{animation:crew-stop .4s linear both}
	[data-still="true"]{animation:none}
	@keyframes crew-leave{0%,76.47%{opacity:1}100%{opacity:0}}
	@keyframes crew-stop{to{opacity:0}}
	@media(prefers-reduced-motion:reduce){.graph-crew{animation:none}}
</style>
