<script lang="ts">
 import LaterMenu from './LaterMenu.svelte';
 import { attentionLaterTargets, writeLater, type LaterDeadline, type LaterTarget } from '#lib/attention-later.js';
 import { coordinatorOfThread } from '#lib/coordinators.js';
 import { workDay } from '#lib/work-day.svelte.js';
 import type { BackendConnection } from '#lib/harness.svelte.js';
 import type { ThreadSummary } from '@kemiri/protocol';

 let { backend, projectId, label, kind, coordinatorId, threads = [] }: {
  backend: BackendConnection;
  projectId: string;
  label: string;
  kind?: string;
  coordinatorId?: string;
  threads?: readonly ThreadSummary[];
 } = $props();

 async function load() {
  const board = await backend.client.readBoard(projectId);
  return attentionLaterTargets(board, { kind, coordinatorId,
   questionInScope: coordinatorId === undefined ? undefined : question => coordinatorOfThread(question.threadId, threads) === coordinatorId });
 }

 // Keep the write destination captured for Undo after this menu or row is gone.
 function saveTo(connection: BackendConnection, id: string) {
  return (target: LaterTarget, deadline: LaterDeadline) => writeLater(connection.client, id, target, deadline, workDay.start);
 }
 const save = $derived(saveTo(backend, projectId));
</script>

{#if backend.ready && backend.supports('attention-later')}
 <LaterMenu {label} {load} {save} compact />
{/if}
