<script lang="ts">
 import Clock from '@lucide/svelte/icons/clock';
 import ChevronRight from '@lucide/svelte/icons/chevron-right';
 import { page } from '$app/state';
 import BoardQuestionCard from './BoardQuestionCard.svelte';
 import LaterMenu from './LaterMenu.svelte';
 import { laterRequest, laterReturnLabel, taskLaterTarget } from '#lib/attention-later.js';
 import { taskStateLabel } from '#lib/task-state.js';
 import { isSettled } from '#lib/tasks.js';
 import { questionAskedBy } from '#lib/threads.js';
 import type { ProjectBoard } from '#lib/board.svelte.js';
 import type { BoardTask, BoardQuestion, ThreadSummary } from '@kemiri/protocol';

 let { board, tasks, questions, threads, taskHref, onopentask }: {
  board: ProjectBoard;
  tasks: readonly BoardTask[];
  questions: readonly BoardQuestion[];
  threads: readonly ThreadSummary[];
  taskHref: (taskId: string) => string;
  onopentask?: (taskId: string) => void;
 } = $props();

 const parkedQuestions = $derived(board.board?.questions.filter(question => question.postponed && question.taskId != null) ?? []);
 const taskless = $derived(questions.filter(question => question.postponed && question.taskId == null));
 const requests = $derived.by(() => {
  const allTasks = board.tasks;
  const roots = new Map<string, BoardTask>();
  for (const task of tasks) {
   const root = laterRequest(allTasks, task.id);
   if (root?.later) roots.set(root.id, root);
  }
  return [...roots.values()].sort((a, b) => a.later!.until.localeCompare(b.later!.until));
 });
 let open = $state(false);
 $effect(() => { if (page.url.hash === '#later') open = true; });
</script>

{#snippet questionCard(question: BoardQuestion)}
 <BoardQuestionCard {board} {question} compact askedBy={questionAskedBy(question, threads)}
  taskHref={question.taskId ? taskHref(question.taskId) : undefined}
  taskLabel={question.taskId ? board.task(question.taskId)?.title : undefined}
  taskFieldsEnabled={board.taskFieldsEnabled}
  onclarify={board.clarifyEnabled ? (entry, text) => board.clarify(entry.id, entry.revision, text) : undefined}
  onanswer={(entry, text) => board.answer(entry.id, entry.revision, text)} />
{/snippet}

{#if board.laterEnabled && (requests.length || taskless.length)}
 <section id="later" aria-label="Later" class="rounded-xl border border-(--chat-border) bg-(--chat-surface)/55" data-section="later">
  <button type="button" aria-expanded={open} onclick={() => open = !open} class="flex min-h-10 w-full cursor-pointer items-center gap-1.5 rounded-xl px-2.5 text-[0.8125rem] font-semibold text-(--chat-fg-muted) hover:bg-(--chat-surface-2) focus-visible:outline-2 focus-visible:outline-(--accent-2)">
   <ChevronRight size={14} class={open ? 'rotate-90' : ''} aria-hidden="true" />
   <Clock size={14} aria-hidden="true" /> Later <span class="ml-0.5 text-xs font-normal tabular-nums text-(--chat-fg-subtle)">{requests.length + taskless.length}</span>
  </button>
  {#if open}
   <ul class="grid min-w-0 gap-1.5 px-2 pb-2">
    {#each requests as request (request.id)}
     {@const target = board.board && taskLaterTarget(board.board, request)}
     {@const covered = parkedQuestions.filter(question => question.taskId != null && laterRequest(board.tasks, question.taskId)?.id === request.id)}
     {@const blocked = board.tasks.filter(task => !isSettled(task.status) && !task.archived && task.blockedBy.some(id => laterRequest(board.tasks, id)?.id === request.id)).length}
     {@const need = covered.length ? covered.length === 1 ? (covered[0]?.kind === 'warning' ? 'Warning' : 'Answer needed') : `${covered.length} questions or warnings` : request.state?.group === 'later' && request.state.kind !== 'waiting_outside' ? taskStateLabel(request) : undefined}
     <li class="min-w-0 rounded-lg border border-(--chat-border) bg-(--chat-bg)/50 p-2">
      <div class="flex items-start gap-2">
       <Clock size={14} class="mt-1 shrink-0 text-(--chat-fg-muted)" aria-hidden="true" />
       <div class="min-w-0 flex-1 text-xs text-(--chat-fg-muted)">
        <a class="break-words text-sm font-medium text-(--chat-fg) hover:underline" href={taskHref(request.id)} onclick={() => onopentask?.(request.id)}>{request.title}</a>
        <p class="mt-0.5">{need ? `${need} · ` : ''}{laterReturnLabel(request.later!)}{blocked ? ` · ${blocked} ${blocked === 1 ? 'task waits' : 'tasks wait'} for it` : ''}</p>
       </div>
       {#if target}<LaterMenu {target} save={board.setLater} />{/if}
      </div>
      {#if covered.length}<div class="mt-2 grid gap-1.5">{#each covered as question (question.id)}{@render questionCard(question)}{/each}</div>{/if}
     </li>
    {/each}
    {#each taskless as question (question.id)}<li class="min-w-0">{@render questionCard(question)}</li>{/each}
   </ul>
  {/if}
 </section>
{/if}
