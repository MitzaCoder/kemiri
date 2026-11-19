<script lang="ts">
	import type { BoardLiveLine } from '@kemiri/protocol';
	import { groupLiveEvidence, type LiveNewsActions } from '#lib/task-live.js';
	import { activityMinute } from '#lib/activity-minute.js';
	import { exactTime, relativeTime } from '#lib/relative-time.js';

	let { line, arrived = false, news }: { line: BoardLiveLine; arrived?: boolean; news?: LiveNewsActions } = $props();
 const evidence = $derived(groupLiveEvidence(line.evidence?.steps ?? []).map(step => ({ ...step, href: news?.workLogHref(line, step.entryId) })));
 const hasWorkLog = $derived(evidence.some(step => step.href));
 let marking = $state(false);
 let error = $state(false);
 async function markWrong() {
  if (!news || marking || line.wrong) return;
  marking = true;
  error = false;
  try { await news.markWrong(line.id); }
  catch { error = true; }
  finally { marking = false; }
 }
</script>

<li class="live-line" class:arrived data-live-line={line.id} data-kind={line.kind}>
 {#snippet context()}
  <span class="live-line-context">
   <span class="live-line-kind">{line.kind === 'auto' ? 'auto' : line.kind === 'fact' ? 'Recorded' : line.kind === 'result' ? 'Result' : 'Phase'}</span>
   <span>{line.actor.name}</span>
   <time datetime={line.at} title={exactTime(line.at)}>{relativeTime(line.at, $activityMinute)}</time>
   {#if line.wrong}<span>Marked wrong</span>{/if}
  </span>
 {/snippet}
 {#if line.kind === 'auto' && news}
  <details>
   <summary>
    {@render context()}
    <span class="live-line-text" class:wrong={line.wrong}>{line.text}</span>
   </summary>
   <div class="live-evidence">
    <strong>Recorded steps</strong>
    <ul>
     {#each evidence as step (step.entryId)}
      <li>
       <span>{step.description}{#if step.count > 1} <span class="live-evidence-count">×{step.count}</span>{/if}</span>
       {#if step.href}<a href={step.href} aria-label={`Open the work log here: ${step.description}`}>Open the work log here</a>{/if}
      </li>
     {/each}
    </ul>
    {#if !hasWorkLog}<p class="live-evidence-note">The work log is not available for this run.</p>{/if}
    {#if !line.wrong}<button type="button" disabled={marking} onclick={markWrong}>This is wrong</button>{/if}
    {#if error}<p role="alert">Could not mark this line wrong. Try again.</p>{/if}
   </div>
  </details>
 {:else}
  {@render context()}
  <p class="live-line-text">{line.text}</p>
 {/if}
</li>

<style>
	.live-line { padding: 0.375rem 0.625rem; border-inline-start: 2px solid var(--chat-border); overflow-wrap: anywhere; }
	.live-line[data-kind='result'] { border-inline-start-color: var(--chat-success); }
	.live-line[data-kind='fact'] { border-inline-start-style: dashed; border-inline-start-color: var(--chat-fg-muted); }
	.live-line[data-kind='fact'] .live-line-text { color: var(--chat-fg); }
	.live-line-context { display: flex; flex-wrap: wrap; gap: 0.125rem 0.625rem; font-size: 0.75rem; color: var(--chat-fg-muted); }
 .live-line[data-kind='auto'] { border-inline-start-style: dotted; }
 .live-line[data-kind='auto'] summary { cursor: pointer; }
 .live-line[data-kind='auto'] summary::marker { color: var(--chat-fg-muted); }
 .live-line[data-kind='auto'] .live-line-context { display: inline-flex; }
 .live-line-text.wrong { text-decoration: line-through; }
 summary .live-line-text { display: block; }
 .live-evidence { display: grid; gap: 0.5rem; margin-top: 0.5rem; padding: 0.625rem; background: var(--chat-surface-2); border-radius: 0.375rem; font-size: 0.75rem; }
 .live-evidence ul { padding-inline-start: 1rem; list-style: disc; }
 .live-evidence li + li { margin-top: 0.25rem; }
 .live-evidence a { display: block; width: fit-content; color: var(--chat-fg-muted); text-decoration: underline; }
 .live-evidence-count, .live-evidence-note { color: var(--chat-fg-muted); }
 .live-evidence button { justify-self: start; border: 1px solid var(--chat-border); border-radius: 0.375rem; min-height: 2rem; padding-inline: 0.5rem; }
 .live-evidence button:disabled { opacity: 0.5; }
	.live-line-kind { font-weight: 600; }
	.live-line-text { font-size: 0.875rem; color: var(--chat-fg-muted); }
	.live-line[data-kind='result'] .live-line-text { color: var(--chat-fg); font-weight: 500; }
	@media (prefers-reduced-motion: no-preference) {
		.arrived { animation: live-arrival 1.4s ease-out; }
		@keyframes live-arrival { from { background: var(--chat-surface-2); } to { background: transparent; } }
	}
</style>
