<script lang="ts">
	import { untrack } from 'svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { Button } from '#lib/components/ui/button/index.js';
	import Markdown from '#lib/components/markdown/Markdown.svelte';
	import { answerWhen } from '#lib/answers.js';
	import type { ProjectAnswers } from '#lib/answers.svelte.js';
	import type { Answer, BoardTask } from '@kemiri/protocol';
	import AnswerTaskChip from './AnswerTaskChip.svelte';

	let { answer, catalogue, now, tasks, listHref, taskHref, chatHref, onnavigate, onleave, ondelete, onopenTask }: {
		answer: Answer; catalogue: ProjectAnswers; now: number; tasks: readonly BoardTask[];
		listHref: string; taskHref: (id: string) => string; chatHref?: string;
		onnavigate: (event: MouseEvent) => void; onleave: (event: MouseEvent) => void; ondelete: () => void; onopenTask: (id: string) => void;
	} = $props();
	let followUp = $state(false);
	let question = $state('');
	let followUpInput = $state<HTMLTextAreaElement>();
	let confirmingDelete = $state(false);
	let acting = $state(false);
	let feedback = $state<string>();
	let error = $state<string>();
	let readError = $state<string>();
	let lastAsk: { question: string | undefined; requestId: string } | undefined;
	const when = $derived(answerWhen(answer.at, now));
	const taskIds = $derived([...new Set([...answer.related, ...(answer.taskId ? [answer.taskId] : [])])]);

	async function markRead(id: string) {
		readError = undefined;
		try { await catalogue.requests.update(id, { read: true }); }
		catch (reason) { readError = reason instanceof Error ? reason.message : String(reason); }
	}

	$effect(() => {
		void answer.at;
		if (catalogue.ready && !answer.read) {
			const id = answer.id;
			untrack(() => void markRead(id));
		}
	});

	$effect(() => { followUpInput?.focus(); });

	async function act(action: () => Promise<void>) {
		if (acting) return;
		acting = true;
		feedback = undefined;
		error = undefined;
		try { await action(); }
		catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
		finally { acting = false; }
	}

	function ask(text?: string) {
		void act(async () => {
			if (!lastAsk || lastAsk.question !== text) lastAsk = { question: text, requestId: crypto.randomUUID() };
			await catalogue.requests.ask(answer.id, lastAsk.requestId, text);
			lastAsk = undefined;
			followUp = false;
			question = '';
			feedback = `Sent to ${answer.coordinatorTitle}. This answer will show the new reply when it is ready.`;
		});
	}
</script>

<article class="mx-auto w-full max-w-2xl px-4 pb-8 sm:px-5" aria-labelledby="answer-title">
	<a href={listHref} onclick={onnavigate} class="my-3 inline-flex items-center gap-1 rounded-md py-1 text-xs font-medium text-(--accent-2) hover:underline"><ArrowLeft size={14} /> Answers</a>
	<header class="mb-4 border-b border-(--chat-border) pb-3">
		<p class="text-xs font-medium text-(--chat-fg-subtle)">Answer · {answer.id}</p>
		<h1 id="answer-title" class="mt-1 text-xl leading-snug font-semibold text-(--chat-fg)">{answer.title}</h1>
		<p class="mt-2 text-xs text-(--chat-fg-muted)">Answered <time datetime={answer.at}>{when}</time> · by {answer.coordinatorTitle}</p>
	</header>
	<Markdown source={answer.answer} />
	{#if taskIds.length}
		<div class="mt-4 flex flex-wrap gap-1.5" aria-label="Related tasks" role="group">
			{#each taskIds as id (id)}
				<AnswerTaskChip {id} task={tasks.find(task => task.id === id)} href={taskHref(id)} showTitle onclick={onleave} />
			{/each}
		</div>
	{/if}
	<p class="mt-4 border-l-2 border-(--chat-border) pl-3 text-xs leading-relaxed text-(--chat-fg-muted)">A snapshot from {when}. It does not update itself.</p>
	<div class="mt-4 flex flex-wrap items-center gap-1.5" role="group" aria-label="Answer actions">
		<Button variant="outline" size="sm" disabled={acting || !catalogue.ready} onclick={() => ask()}>Ask again</Button>
		<Button variant="outline" size="sm" disabled={acting || !catalogue.ready} aria-expanded={followUp} onclick={() => followUp = !followUp}>Ask a follow-up…</Button>
		{#if !answer.taskId}
			<Button variant="outline" size="sm" disabled={acting || !catalogue.ready} onclick={() => act(async () => {
				const taskId = await catalogue.requests.turnIntoTask(answer.id);
				onopenTask(taskId);
			})}>Turn into a task</Button>
		{/if}
		<Button variant="ghost" size="sm" disabled={acting || !catalogue.ready} onclick={() => act(async () => {
			await catalogue.requests.update(answer.id, { pinned: !answer.pinned });
		})}>{answer.pinned ? 'Unpin' : 'Pin'}</Button>
		{#if chatHref}<Button variant="ghost" size="sm" href={chatHref} onclick={onleave}>Show in chat</Button>{/if}
		<Button variant="ghost" size="sm" class="text-(--chat-danger)" disabled={acting || !catalogue.ready} aria-expanded={confirmingDelete} onclick={() => confirmingDelete = !confirmingDelete}>Delete</Button>
	</div>
	{#if followUp}
		<form class="mt-3 space-y-2 rounded-lg border border-(--chat-border) p-3" onsubmit={event => { event.preventDefault(); if (question.trim()) ask(question.trim()); }}>
			<label for="answer-follow-up" class="block text-sm font-medium">Follow-up question</label>
			<textarea id="answer-follow-up" bind:this={followUpInput} bind:value={question} rows="3" disabled={acting} class="w-full rounded-md border border-(--chat-border) bg-(--chat-bg) p-2 text-base"></textarea>
			<Button type="submit" size="sm" disabled={acting || !catalogue.ready || !question.trim()}>Send follow-up</Button>
			<Button variant="ghost" size="sm" onclick={() => followUp = false}>Cancel</Button>
		</form>
	{/if}
	{#if confirmingDelete}
		<div class="mt-3 rounded-lg border border-(--chat-border) p-3">
			<p class="mb-2 text-sm">Delete this answer and its earlier replies? The chat and linked tasks will stay.</p>
			<Button variant="destructive" size="sm" disabled={acting || !catalogue.ready} onclick={() => act(async () => {
				await catalogue.requests.delete(answer.id);
				ondelete();
			})}>Delete answer</Button>
			<Button variant="ghost" size="sm" onclick={() => confirmingDelete = false}>Cancel</Button>
		</div>
	{/if}
	{#if feedback}<p class="mt-3 text-sm text-(--chat-fg-muted)" role="status">{feedback}</p>{/if}
	{#if error}<p class="mt-3 text-sm text-(--chat-danger)" role="alert">{error}</p>{/if}
	{#if readError}
		<p class="mt-3 text-sm text-(--chat-danger)" role="alert">Could not mark this answer read: {readError}
			<button class="font-medium underline" onclick={() => markRead(answer.id)}>Retry</button>
		</p>
	{/if}
	{#if answer.exchanges.length}
		<section class="mt-6 border-t border-(--chat-border) pt-4" aria-labelledby="answer-earlier-replies">
			<h2 id="answer-earlier-replies" class="mb-2 text-sm font-semibold">Earlier replies</h2>
			{#each answer.exchanges as exchange}
				<div class="space-y-2 border-b border-(--chat-border) py-3 last:border-0">
					<p class="text-xs text-(--chat-fg-muted)">Answered <time datetime={exchange.at}>{answerWhen(exchange.at, now)}</time> · by {exchange.coordinatorTitle}</p>
					<p class="text-sm font-medium">{exchange.question}</p>
					<Markdown source={exchange.answer} />
				</div>
			{/each}
		</section>
	{/if}
</article>
