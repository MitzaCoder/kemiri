<script lang="ts">
 import { DropdownMenu } from 'bits-ui';
 import type { BoardTaskStatus, BoardTask } from '@kemiri/protocol';
 import TaskStatusBadge from './TaskStatusBadge.svelte';
 import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
 import { taskDisplayWords, taskDisplayToneClass, taskStatusToneClass, taskStatusWords } from '#lib/tasks.js';
 import { TASK_STATUS_CHOICES } from '#lib/task-waiting.js';
 let {task, status, supportsWaiting, label, compact=false, disabled=false, onpick}: {task?:BoardTask; status:BoardTaskStatus; supportsWaiting:boolean; label?:string; compact?:boolean; disabled?:boolean; onpick:(status:BoardTaskStatus)=>void}=$props();
 const statusTone = $derived(task?.state?.liveWorkSince ? taskStatusToneClass('in_progress') : task ? taskDisplayToneClass(task) : taskStatusToneClass(status));
 const statusLabel = $derived(label ?? (task ? taskDisplayWords(task) : taskStatusWords(status)));
</script>
{#if disabled}
 {#if label || task?.state}<span class="inline-flex items-center gap-2 text-xs {statusTone}"><span class="task-status-dot"></span>{statusLabel}</span>{:else}<TaskStatusBadge {status}/>{/if}
{:else}
<DropdownMenu.Root>
 <DropdownMenu.Trigger class="group inline-flex cursor-pointer items-center {compact ? 'task-status-touch rounded-full' : 'gap-2 rounded-lg border border-(--chat-border-strong) bg-(--chat-surface) px-2.5 py-1.5 text-xs font-medium text-(--chat-fg) outline-none hover:bg-(--chat-surface-2) active:bg-(--chat-border) data-[state=open]:bg-(--chat-surface-2) focus-visible:ring-2 focus-visible:ring-(--accent-2) focus-visible:ring-offset-2 focus-visible:ring-offset-(--chat-surface)'} {label && !compact ? 'min-h-11' : ''}" aria-label="Change task status: {statusLabel}" title="Change status" data-status-trigger>
  <span class={compact ? 'task-status-pill' : 'contents'}>
   <span class="task-status-dot shrink-0 {statusTone}" aria-hidden="true"></span>
   <span class:truncate={compact}>{statusLabel}</span>
   <ChevronDownIcon class="size-3.5 shrink-0 text-(--chat-fg-muted) transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" aria-hidden="true"/>
  </span>
 </DropdownMenu.Trigger>
 <DropdownMenu.Portal><DropdownMenu.Content sideOffset={6} align="start" class="z-[100] max-h-[70dvh] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-(--chat-border) bg-(--chat-surface) p-1 shadow-xl" data-status-menu>
  <DropdownMenu.RadioGroup value={status} onValueChange={(value)=>onpick(value as BoardTaskStatus)}>
   {#each TASK_STATUS_CHOICES.filter(choice=>supportsWaiting || choice.status!=='waiting') as choice}
    <DropdownMenu.RadioItem value={choice.status} class="flex cursor-pointer items-center gap-3 rounded-lg p-2.5 outline-none data-highlighted:bg-(--chat-surface-2)">
     <span class="task-status-dot shrink-0 {taskStatusToneClass(choice.status)}" aria-hidden="true"></span>
     <span><span class="block text-sm font-medium">{choice.label}</span><span class="block text-xs text-(--chat-fg-subtle)">{choice.hint}</span></span>
    </DropdownMenu.RadioItem>
   {/each}
  </DropdownMenu.RadioGroup>
 </DropdownMenu.Content></DropdownMenu.Portal>
</DropdownMenu.Root>
{/if}
