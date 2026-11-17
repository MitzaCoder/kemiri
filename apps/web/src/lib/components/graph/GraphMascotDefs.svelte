<script lang="ts">
	import { graphMascotSvg } from '../../generated/graph-mascot.js';
	let { gradientPrefix = 'graph-mascot' }: { gradientPrefix?: string } = $props();
	const svg = $derived(graphMascotSvg(gradientPrefix));
</script>

<!-- Exactly once per graph SVG. Match gradientPrefix on every GraphMascot. -->
<defs>{@html svg.definitions}</defs>
