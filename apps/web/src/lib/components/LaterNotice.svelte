<script lang="ts">
 import { laterUndo } from '#lib/later-undo.svelte.js';
 import { Button } from './ui/button/index.js';
 import { untrack } from 'svelte';
 let { inDialog = false }: { inDialog?: boolean } = $props();
 const host = Symbol('Later notice');
 $effect(() => { if (inDialog) return untrack(() => laterUndo.mountDialog(host)); });
 const visible = $derived(laterUndo.dialogHosts.at(-1) === (inDialog ? host : undefined));
</script>

{#if visible && laterUndo.notice}
 <div class="{inDialog ? 'absolute' : 'fixed'} bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-[120] flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-xl border border-(--chat-border) bg-(--chat-surface) py-1 pr-1 pl-3 text-sm text-(--chat-fg) shadow-lg">
  <span role="status" class="py-1">{laterUndo.notice.text}</span>
  {#if laterUndo.notice.undo}<Button variant="ghost" size="sm" disabled={laterUndo.pending} onclick={() => laterUndo.restore()}>Undo</Button>{/if}
  <Button variant="ghost" size="icon-sm" aria-label="Dismiss Later notice" onclick={() => laterUndo.dismiss()}>×</Button>
 </div>
{/if}
