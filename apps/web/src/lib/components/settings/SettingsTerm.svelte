<script lang="ts">
 let { term }: { term?: string } = $props();
</script>

{#if term}<span class="text-xs font-normal leading-4 text-muted-foreground">{term}</span>{/if}
