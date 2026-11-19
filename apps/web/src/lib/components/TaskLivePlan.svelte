<script lang="ts">
 import { livePlanProgress, type BoardLivePlanStep } from '@kemiri/protocol';

 let { plan, foldOnPhone = false }: { plan: BoardLivePlanStep[]; foldOnPhone?: boolean } = $props();
 const progress = $derived(livePlanProgress(plan));
 const currentStep = $derived(plan.find(step => step.status === 'doing') ?? plan.find(step => step.status === 'todo'));
 const longPlan = $derived(foldOnPhone && plan.length > 3);
 let expanded = $state(false);
 const listId = $props.id();
 const marks = { done: '✓', doing: '◐', todo: '○' };
 const statusLabels = { done: 'Done', doing: 'In progress', todo: 'To do' };
</script>

<div class="live-plan" class:fold-on-phone={longPlan} class:expanded>
 <div class="plan-heading">
  <h3>Plan <span class="plan-progress">{progress}</span></h3>
  {#if longPlan}
   <button type="button" aria-expanded={expanded} aria-controls={listId} onclick={() => { expanded = !expanded; }}>
    {expanded ? 'Hide steps' : 'Show steps'}
   </button>
  {/if}
 </div>
 <ol id={listId} role="list" aria-label="Plan steps">
  {#each plan as step}
   <li class:current-step={step === currentStep} data-status={step.status}>
    <span class="step-mark" aria-hidden="true">{marks[step.status]}</span>
    <span class="sr-only">{statusLabels[step.status]}: </span><span>{step.text}</span>
   </li>
  {/each}
 </ol>
</div>

<style>
 .live-plan { min-width: 0; }
 .plan-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 0.25rem 0.75rem; }
 h3 { font-size: 0.8125rem; font-weight: 600; }
 .plan-progress { margin-inline-start: 0.375rem; color: var(--chat-fg-muted); font-weight: 400; font-variant-numeric: tabular-nums; }
 ol { display: grid; gap: 0.125rem; margin-top: 0.25rem; }
 li { display: flex; gap: 0.5rem; font-size: 0.8125rem; overflow-wrap: anywhere; color: var(--chat-fg-muted); }
 .step-mark { flex: 0 0 1rem; text-align: center; }
 li[data-status='doing'] { color: var(--chat-fg); font-weight: 600; }
 li[data-status='done'] .step-mark { color: var(--chat-success); }
 li[data-status='todo'] { color: var(--chat-fg-subtle); }
 button { display: none; color: var(--chat-fg-muted); font-size: 0.75rem; text-decoration: underline; }
 @media (max-width: 480px) {
  .fold-on-phone button { display: inline-block; min-height: 24px; }
  .fold-on-phone:not(.expanded) li:not(.current-step) { display: none; }
  .fold-on-phone:not(.expanded) ol:not(:has(.current-step)) { display: none; }
 }
</style>
