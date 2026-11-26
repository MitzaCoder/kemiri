<script lang="ts">
 import { Popover } from 'bits-ui';
 import Clock from '@lucide/svelte/icons/clock';
 import ChevronRight from '@lucide/svelte/icons/chevron-right';
 import { Button } from './ui/button/index.js';
 import type { BoardLaterSetResponse } from '@kemiri/protocol';
 import { laterChoices, laterDateInput, laterDateLabel, laterDateLimit, type LaterDeadline, type LaterTarget } from '#lib/attention-later.js';
 import { laterUndo } from '#lib/later-undo.svelte.js';
 import { workDay } from '#lib/work-day.svelte.js';

 let { target, label, load, save, compact = false }: {
  target?: LaterTarget;
  /** Label for a grouped attention row that loads its own targets. */
  label?: string;
  load?: () => Promise<LaterTarget[]>;
  save: (target: LaterTarget, deadline: LaterDeadline) => Promise<BoardLaterSetResponse>;
  compact?: boolean;
 } = $props();
 let open = $state(false);
 let loading = $state(false);
 let pending = $state(false);
 let targets = $state<LaterTarget[]>([]);
 let picked = $state<LaterTarget>();
 let pickingDate = $state(false);
 let date = $state('');
 let problem = $state<string>();
 let now = $state(new Date());
 let loadSequence = 0;
 const selected = $derived(target ?? picked ?? (targets.length === 1 ? targets[0] : undefined));
 const choices = $derived(selected ? laterChoices(now, workDay.start, selected) : []);
 const menuButton = 'flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-sm hover:bg-(--chat-surface-2) focus-visible:outline-2 focus-visible:outline-(--accent-2) disabled:opacity-50';

 async function changeOpen(next: boolean) {
  open = next;
  const sequence = ++loadSequence;
  if (!next) return;
  now = new Date();
  picked = undefined;
  targets = [];
  pickingDate = false;
  date = '';
  problem = undefined;
  if (!load) return;
  loading = true;
  try {
   const loaded = await load();
   if (loadSequence === sequence) targets = loaded;
  } catch (error) {
   if (loadSequence === sequence) problem = error instanceof Error ? error.message : 'Could not read what needs attention.';
  } finally { if (loadSequence === sequence) loading = false; }
 }

 async function submit(deadline: LaterDeadline) {
  if (!selected || pending) return;
  const subject = $state.snapshot(selected);
  const write = save;
  pending = true;
  problem = undefined;
  try {
   const response = await write(subject, deadline);
   open = false;
   if (response.later) laterUndo.show('Put aside for Later.', () => write({ ...subject, revision: response.revision }, { until: null }));
   else laterUndo.show('Brought back.');
  } catch (error) {
   const text = error instanceof Error ? error.message : 'Could not change Later.';
   if (open) problem = text;
   else laterUndo.show(text);
  } finally { pending = false; }
 }

 function submitDate(event: SubmitEvent) {
  event.preventDefault();
  if (!selected) return;
  const until = new Date(date);
  const current = new Date();
  if (!Number.isFinite(until.getTime()) || until <= current || until > laterDateLimit(current, workDay.start, selected.urgent)) {
   problem = selected.urgent ? 'Pick a time no later than tomorrow morning.' : 'Pick a future time within 30 days.';
   return;
  }
  void submit({ until: until.toISOString() });
 }
</script>

{#if target?.later}
 <Button size="sm" variant="ghost" class="relative z-10 min-h-8 shrink-0 whitespace-nowrap text-xs text-(--chat-fg-muted)" disabled={pending}
  aria-label="Bring back: {target.label}" onclick={() => submit({ until: null })}>Bring back</Button>
{:else if target || load}
 <Popover.Root {open} onOpenChange={changeOpen}>
  <Popover.Trigger class="later-trigger relative z-10 inline-flex min-h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-(--chat-fg-muted) hover:bg-(--chat-surface-2) hover:text-(--chat-fg) focus-visible:outline-2 focus-visible:outline-(--accent-2) data-[state=open]:bg-(--chat-surface-2)" data-compact={compact ? '' : undefined}
   aria-label="Later: {target?.label ?? label}" title="Later" disabled={pending}>
   <Clock size={15} aria-hidden="true" />{#if !compact}Later{/if}
  </Popover.Trigger>
  <Popover.Portal>
   <Popover.Content align={compact ? "end" : "start"} sideOffset={6} collisionPadding={8} class="z-[110] max-h-[min(28rem,75dvh)] w-72 max-w-[calc(100vw-1.5rem)] overflow-auto rounded-xl border border-(--chat-border) bg-(--chat-surface) p-1.5 text-(--chat-fg) shadow-xl" aria-label="Later choices">
    <p class="px-2 pt-1.5 text-sm font-semibold">Later</p>
    {#if loading}
     <p class="px-2 py-2 text-xs text-(--chat-fg-muted)" role="status">Reading what needs attention…</p>
    {:else if selected}
     <p class="line-clamp-2 px-2 pb-1 text-xs text-(--chat-fg-muted)">{selected.label}</p>
     {#if selected.urgent}<p class="px-2 pb-1 text-xs text-(--chat-fg-muted)">This can wait until tomorrow morning at most.</p>{/if}
     {#if pickingDate}
      <form class="grid gap-2 p-2" onsubmit={submitDate}>
       <label class="grid gap-1 text-xs">Return date and time
        <input type="datetime-local" required bind:value={date} max={laterDateInput(laterDateLimit(now, workDay.start, selected.urgent))}
         class="min-h-10 w-full rounded-md border border-(--chat-border) bg-(--chat-bg) p-2 text-sm" />
       </label>
       <div class="flex justify-end gap-2"><Button variant="ghost" size="sm" onclick={() => pickingDate = false}>Back</Button><Button type="submit" size="sm" disabled={pending}>Put aside</Button></div>
      </form>
     {:else}
      {#each choices.filter(choice => !choice.whenLast) as choice (choice.label)}
       <button class={menuButton} type="button" disabled={pending} onclick={() => submit(choice)}>
        <span>{choice.label}</span><small class="text-right text-(--chat-fg-muted)">{laterDateLabel(choice.until!)}</small>
       </button>
      {/each}
      <button class={menuButton} type="button" disabled={pending} onclick={() => { pickingDate = true; problem = undefined; }}>Pick a date <ChevronRight size={14} aria-hidden="true" /></button>
      {#each choices.filter(choice => choice.whenLast) as choice (choice.label)}
       <button class={menuButton} type="button" disabled={pending} onclick={() => submit(choice)}>{choice.label}</button>
      {/each}
      {#if picked && targets.length > 1}<button type="button" class={menuButton} disabled={pending} onclick={() => { picked = undefined; problem = undefined; }}>Back to items</button>{/if}
     {/if}
    {:else if targets.length}
     <p class="px-2 pb-1 text-xs text-(--chat-fg-muted)">Choose what to put aside</p>
     {#each targets as candidate (JSON.stringify(candidate.target))}
      <button class={menuButton} type="button" onclick={() => picked = candidate}><span class="break-words">{candidate.label}</span><ChevronRight size={14} class="shrink-0" aria-hidden="true" /></button>
     {/each}
    {:else if !problem}
     <p class="px-2 py-2 text-xs text-(--chat-fg-muted)">Nothing here can go to Later.</p>
    {/if}
    {#if problem}<p class="px-2 py-1 text-xs text-(--chat-warning)" role="alert">{problem}</p>{/if}
   </Popover.Content>
  </Popover.Portal>
 </Popover.Root>
{/if}

<style>
 @media (pointer: fine) { :global(.later-trigger[data-compact]:not(:hover, :focus-visible, [data-state='open'])) { opacity: .72; } }
 @media (pointer: coarse) { :global(.later-trigger) { min-height: 44px; min-width: 44px; } }
</style>
