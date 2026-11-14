<script lang="ts">
	import { GENERAL_SECTIONS } from '#lib/settings.js';
</script>
<section class="flex flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10">
	<h2 class="text-xl font-semibold">Settings overview</h2>
	<p class="text-sm text-muted-foreground">Choose a section to manage this browser and its backends.</p>
	{#each GENERAL_SECTIONS as section}<div><h3 class="font-medium">{section.label}</h3><p class="text-sm text-muted-foreground">{section.hint}</p></div>{/each}
</section>
