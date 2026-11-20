<script lang="ts">
	import { onMount } from 'svelte';
	import { newestDiscussionFollowUp, settledDiscussionTask } from '#lib/artifact-discuss.js';
	import { draftFromTask, draftToInput } from '#lib/board.js';
	import type { DiscussionChat } from '#lib/discussion-chat.js';
	import type { BoardTask } from '@kemiri/protocol';
	let { chat, homeTaskId, artifactTitle, messageKey, sentAt }: { chat: DiscussionChat; homeTaskId: string; artifactTitle: string; messageKey: string; sentAt: number } = $props();
	type Choice = 'reopen' | 'answer';
	let confirm = $state<Choice>();
	let busy = $state(false);
	let result = $state('');
	let problem = $state('');
	let reopened = $state(false);
	let dropped = $state<string>();
	const storageKey = $derived(`aiki.discussion-overrule:${JSON.stringify([chat.backend.id, chat.projectId, messageKey])}`);
	const labels = { reopen: 'Reopen the old task instead', answer: 'Only answer here' } as const;
	onMount(() => { try { result = localStorage.getItem(storageKey) ?? ''; } catch { /* optional device storage */ } });

	async function saveStatus(task: BoardTask, status: 'in_progress' | 'dropped') {
		return chat.backend.client.saveBoardTask(chat.projectId, { ...draftToInput(draftFromTask(task)), status }, { taskId: task.id, expectedRevision: task.revision });
	}

	async function apply(choice: Choice) {
		if (busy) return;
		busy = true;
		problem = '';
		try {
			const board = await chat.backend.client.readBoard(chat.projectId, { includeArchived: true });
			const home = board.tasks.find(task => task.id === homeTaskId);
			if (!home || (!reopened && (!settledDiscussionTask(home) || (home.settledAt && Date.parse(home.settledAt) > sentAt)))) throw new Error('The old task has changed. No more changes were made.');
			const followUp = newestDiscussionFollowUp(board.tasks, homeTaskId, sentAt);
			if (choice === 'reopen' && !reopened) { await saveStatus(home, 'in_progress'); reopened = true; }
			if (!dropped && followUp && followUp.status !== 'dropped') {
				await saveStatus(followUp, 'dropped');
				dropped = followUp.id;
			}
			const title = artifactTitle.replaceAll('"', '′');
			const text = choice === 'reopen' ? `I reopened ${home.id} for my discussion of "${title}". Continue on that task instead of starting a follow-up.` : `Only answer here about "${title}". Do not reopen ${home.id} or start a follow-up.`;
			await chat.backend.client.submit(chat.projectId, text, { whenBusy: 'steer', keepDraft: true, requestId: `discuss-overrule-${messageKey}`, ...(choice === 'reopen' ? { taskId: home.id } : {}) });
			result = `${choice === 'reopen' ? `Reopened ${home.id}.` : 'Asked for an answer here.'}${dropped ? ` Dropped follow-up ${dropped}.` : ''}`;
			try { localStorage.setItem(storageKey, result); } catch { /* optional device storage */ }
			confirm = undefined;
		} catch (error) {
			problem = [reopened ? `Reopened ${homeTaskId}.` : '', dropped ? `Dropped follow-up ${dropped}.` : '', error instanceof Error ? error.message : String(error)].filter(Boolean).join(' ');
		} finally { busy = false; }
	}
</script>

<div class="flex max-w-[85%] flex-wrap justify-end gap-1.5 text-xs" data-discussion-overrule>
	{#if result}<p role="status" class="text-(--chat-fg-muted)">{result}</p>
	{:else if confirm}
		<span class="text-(--chat-fg-muted)">{confirm === 'reopen' ? 'Reopen the old task and drop its follow-up, if there is one?' : 'Ask for an answer here and drop the follow-up, if there is one?'}</span>
		<button type="button" class="overrule" disabled={busy || !chat.backend.ready} onclick={() => confirm && apply(confirm)}>{busy ? 'Applying…' : problem ? 'Retry' : 'Confirm'}</button>
		{#if !reopened && !dropped}<button type="button" class="overrule" disabled={busy} onclick={() => { confirm = undefined; problem = ''; }}>Cancel</button>{/if}
	{:else if chat.relevant(homeTaskId, sentAt)}
		<button type="button" class="overrule" onclick={() => confirm = 'reopen'}>{labels.reopen}</button>
		<button type="button" class="overrule" onclick={() => confirm = 'answer'}>{labels.answer}</button>
	{/if}
	{#if problem}<p role="alert" class="w-full text-right text-(--chat-warning)">{problem}</p>{/if}
</div>
<style>
	.overrule { border:1px solid var(--chat-border); border-radius:8px; padding:5px 9px; color:var(--chat-fg); background:var(--chat-surface-2); }
	.overrule:hover { border-color:var(--accent-2); }
</style>
