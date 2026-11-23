<script lang="ts">
	import { otherLandingTurnWaiters, useLandingTurn } from '#lib/landing-turn.js';
	import TaskDetailText from './TaskDetailText.svelte';
	import { fitQuestionDialogToViewport } from '#lib/question-dialog-viewport.js';
	import CardMarkdown from './markdown/CardMarkdown.svelte';
	import Markdown from './markdown/Markdown.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import { markdownText } from '@kemiri/protocol';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import SendIcon from '@lucide/svelte/icons/send';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import type { AnswerOutcome, ClarifyOutcome } from '#lib/board.svelte.js';
	import { askAgainText, canClarifyQuestion, highlightAskBack } from '#lib/question-clarify.js';
	import { shortWriterLabel } from '#lib/tasks.js';
	import { questionAnswers } from '#lib/task-details.js';
	import type { BoardQuestion } from '@kemiri/protocol';

	/**
	 * One question the coordinator asked: its text, suggested answers, and a free-text answer. Used in the
	 * Tasks tab, the task sheet and pinned above the composer. An answer is sent on the revision the question was read
	 * at; when the question moved on meanwhile the card says so and keeps what was typed. A warning looks different and
	 * has no options: the user acknowledges it, with a note if they like.
	 */
	let {
		question,
		taskLabel,
		askedBy,
		taskHref,
		onanswer,
		onclarify,
		compact = false,
		plain = false,
		strip = false,
		optionsOnly = false,
		taskFieldsEnabled = false
	}: {
		question: BoardQuestion;
		/** "T4 · Fix parser recovery" when the question is about a task. */
		taskLabel?: string;
		/** The background thread that asked, by name; undefined for main. The answer goes to the thread that asked. */
		askedBy?: string;
		/** Where the task opens; the task label becomes a link. */
		taskHref?: string;
		onanswer?: (question: BoardQuestion, answer: string) => Promise<AnswerOutcome>;
		onclarify?: (question: BoardQuestion, text: string) => Promise<ClarifyOutcome>;
		compact?: boolean;
		/** Use the surrounding task page surface instead of a tinted card. */
		plain?: boolean;
		/** A single-line preview in a job band; full Markdown opens in the existing reader. */
		strip?: boolean;
		/** Graph preview: suggested answers only; replies and other actions stay in the full task. */
		optionsOnly?: boolean;
		taskFieldsEnabled?: boolean;
	} = $props();

	const warning = $derived(question.kind === 'warning');
	const readLandingTurn = useLandingTurn();
	const turnWaiters = $derived.by(() => {
		const landing = readLandingTurn?.();
		return landing && !warning && question.status === 'open' ? otherLandingTurnWaiters(landing.turn, question.threadId, landing.threads) : [];
	});
	const canAnswer = $derived(question.status === 'open' && onanswer !== undefined);
	const canClarify = $derived(canClarifyQuestion(question, onclarify !== undefined));
	const waitingForAgent = $derived(question.status === 'open' && question.waitingOn === 'agent');
	const exchanges = $derived(question.exchanges ?? []);
	const revisions = $derived(exchanges.filter(exchange => exchange.previousWording || exchange.previousAnswer));
	let draftRevision = $state<number | undefined>(undefined);
	let readingExpanded = $state(false);
	let readingDialog = $state<HTMLElement | null>(null);
	let text = $state('');
	const askHighlighted = $derived(highlightAskBack(text, canClarify));
	let busy = $state(false);
	let problem = $state<string | undefined>(undefined);

	$effect(() => {
		if (readingDialog === null) return;
		return fitQuestionDialogToViewport(readingDialog);
	});

	async function send(answer: string, clarify = false, typed = false): Promise<void> {
		const trimmed = answer.trim();
		if (trimmed.length === 0 || busy || !canAnswer || onanswer === undefined) return;
		busy = true;
		problem = undefined;
		try {
			const revision = typed ? draftRevision ?? question.revision : question.revision;
			const readQuestion = { ...question, revision };
			if (clarify && (!canClarify || !onclarify)) return;
			const outcome = clarify ? await onclarify!(readQuestion, trimmed) : await onanswer(readQuestion, trimmed);
			if (outcome.kind === 'answered' || outcome.kind === 'clarified') {
				text = '';
				draftRevision = undefined;
				if (outcome.kind === 'answered') readingExpanded = false;
			} else if (outcome.kind === 'conflict') {
				problem =
					outcome.newer === undefined || outcome.newer.status !== 'open'
						? warning
							? 'This warning was already acknowledged or withdrawn.'
							: 'This question was already answered or withdrawn.'
						: 'The coordinator changed this question. Read it again, then send the answer or ask back.';
				// The next deliberate send uses the newly displayed revision; the draft is kept.
				draftRevision = outcome.newer?.revision;
			} else problem = outcome.message;
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : 'The answer could not be sent. Try again.';
		} finally {
			busy = false;
		}
	}

	function acknowledge(): void {
		void send(text.trim().length === 0 ? 'Acknowledged' : text, false, true);
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			if (askHighlighted) void send(text, true, true);
			else if (warning) acknowledge();
			else void send(text, false, true);
		}
	}
</script>

{#snippet answerForm(expanded: boolean)}
	{@const answers = questionAnswers(question, (!optionsOnly && (!strip || expanded)) && (taskFieldsEnabled || question.outsideModelApproval === true))}
	{#if answers.kind === 'choices'}
		<ul role="list" aria-label="Suggested answers" class="flex flex-col gap-1.5 {expanded ? 'question-answer-choices' : ''}">
			{#each answers.choices as choice}
				<li>
					<button
						type="button"
						disabled={busy}
						class="flex min-h-11 w-full flex-col justify-center gap-0.5 rounded-lg border px-3 py-2 text-left text-sm leading-snug [overflow-wrap:anywhere] transition-colors hover:border-(--accent-2) hover:bg-(--chat-surface-2) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--chat-ring) disabled:opacity-50 {choice.recommended ? 'border-(--accent-2) bg-(--accent-2)/10' : 'border-(--chat-border-strong) bg-(--chat-surface)'}"
						onclick={() => send(choice.label)}
					>
						<span class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
							<span class="font-semibold">{markdownText(choice.label)}</span>
							{#if choice.recommended}<span class="rounded-full border border-(--accent-2)/50 px-1.5 py-px text-[0.6875rem] font-semibold">Recommended</span>{/if}
						</span>
						{#if choice.effect?.trim()}<span class="text-xs text-(--chat-fg-muted)">{markdownText(choice.effect)}</span>{/if}
					</button>
				</li>
			{/each}
		</ul>
	{:else if answers.options.length > 0}
		<div class="flex flex-wrap gap-1.5 {expanded ? 'question-answer-options' : ''}" role="group" aria-label="Suggested answers">
			{#each answers.options as option (option)}
				<button
					type="button"
					disabled={busy}
					class:preview-option={optionsOnly}
					class="max-w-full rounded-full border border-(--chat-border) bg-(--chat-surface) px-2.5 py-1 text-left text-xs font-medium break-words text-(--chat-fg) transition-colors hover:border-(--accent-2) hover:bg-(--chat-surface-2) disabled:opacity-50"
					onclick={() => send(option)}
				>
					<TaskDetailText text={markdownText(option)} focusable={false} />
				</button>
			{/each}
		</div>
	{/if}

	{#if !optionsOnly && !question.outsideModelApproval}
	<div class="flex flex-wrap items-end justify-end gap-1.5">
		<Textarea
			bind:value={text}
			rows={expanded || compact ? 1 : 2}
			disabled={busy}
			placeholder={warning ? 'Add a note (optional)' : (answers.kind === 'choices' || answers.options.length > 0) ? 'Or answer in your own words' : 'Your answer'}
			aria-label={warning ? `Note for ${question.id}` : `Answer to ${question.id}`}
			oninput={() => { draftRevision ??= question.revision; }}
			class="min-h-9 max-h-32 min-w-0 flex-1 {canClarify ? 'basis-full' : ''} resize-none rounded-lg border-(--chat-border) bg-(--chat-surface)/50 px-2.5 py-1.5 {expanded ? 'question-answer-input text-base md:text-base' : 'text-xs md:text-xs'}"
			onkeydown={onKeydown}
		/>
		{#if warning}
			<Button variant={askHighlighted ? 'outline' : 'default'} size="sm" disabled={busy} onclick={acknowledge} title={askHighlighted ? "Acknowledge the warning" : "Acknowledge (Ctrl+Enter)"} aria-label={plain ? `Got it: acknowledge ${question.id}` : `Acknowledge ${question.id}`}>
				<CheckIcon />{plain ? 'Got it' : 'Acknowledge'}
			</Button>
		{:else}
			<Button
				size={canClarify ? "sm" : "icon-sm"}
				variant={askHighlighted ? "outline" : "default"}
				disabled={busy || text.trim().length === 0}
				onclick={() => send(text, false, true)}
				aria-label="Send the answer to {question.id}"
				title={askHighlighted ? "Send as an answer" : "Send (Ctrl+Enter)"}
			>
				<SendIcon />{#if canClarify}Send{/if}
			</Button>
		{/if}
		{#if canClarify}
			<Button
				size="sm"
				variant={askHighlighted ? 'default' : 'outline'}
				disabled={busy || text.trim().length === 0}
				onclick={() => send(text, true, true)}
				aria-label="Ask back about {question.id}"
				title={askHighlighted ? 'Ask back (Ctrl+Enter)' : 'Ask for clarification without answering'}
				data-ask-back
			>Ask back</Button>
		{/if}
	</div>
	{/if}
	{#if problem}
		<p class="text-xs break-words {expanded ? 'max-h-16 overflow-y-auto' : ''} text-(--chat-danger)" role="alert">{problem}</p>
	{/if}
{/snippet}

{#snippet exchangeRow(exchange: NonNullable<BoardQuestion['exchanges']>[number])}
	<div class="min-w-0">
		<p class="text-xs text-(--chat-fg-subtle)">
			{exchange.author.author === 'user' ? 'You' : exchange.author.threadId === question.threadId ? askedBy ?? 'The coordinator' : shortWriterLabel(exchange.author)}
			· <time datetime={exchange.at} title={new Date(exchange.at).toLocaleString()}>{new Date(exchange.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
		</p>
		<CardMarkdown source={exchange.text} />
	</div>
{/snippet}

{#snippet questionDiscussion()}
	{#if revisions.length > 0}
		<details class="text-xs text-(--chat-fg-muted)" data-question-revised>
			<summary class="min-h-8 cursor-pointer content-center font-medium">Revised · Earlier wording</summary>
			<div class="flex flex-col gap-2 border-l-2 border-(--chat-border) pl-3">
				{#each revisions as exchange}
					{#if exchange.previousWording}
						<div>
							<p>Revision {exchange.previousWording.revision}</p>
							<CardMarkdown source={exchange.previousWording.text} />
							{#if exchange.previousWording.options.length}<ul class="list-inside list-disc">{#each exchange.previousWording.options as option}<li><TaskDetailText text={markdownText(option)} focusable={false} /></li>{/each}</ul>{/if}
						</div>
					{/if}
					{#if exchange.previousAnswer}
						<div><p>Earlier answer · <time datetime={exchange.previousAnswer.at}>{new Date(exchange.previousAnswer.at).toLocaleString()}</time></p><CardMarkdown source={exchange.previousAnswer.text} /></div>
					{/if}
				{/each}
			</div>
		</details>
	{/if}
	{#if exchanges.length > 0}
		<section class="flex min-w-0 flex-col gap-2 border-l-2 border-(--chat-border) pl-3" aria-label="Clarification thread for {question.id}">
			{#if exchanges.length > 2}
				<details>
					<summary class="min-h-8 cursor-pointer content-center text-xs text-(--chat-fg-muted)">Earlier ({exchanges.length - 2})</summary>
					<div class="flex flex-col gap-2">{#each exchanges.slice(0, -2) as exchange}{@render exchangeRow(exchange)}{/each}</div>
				</details>
			{/if}
			{#each exchanges.slice(-2) as exchange}{@render exchangeRow(exchange)}{/each}
		</section>
	{/if}
	{#if question.status === 'open'}
		<div class="flex flex-wrap items-center gap-2 text-xs text-(--chat-fg-muted)" role="status">
			{#if waitingForAgent}<span>Waiting for the agent</span>
			{:else if question.noReplyYet}
				<span>No reply yet</span>
				{#if canClarify && askAgainText(question)}
					<Button size="sm" variant="outline" disabled={busy} onclick={() => send(askAgainText(question)!, true)} aria-label="Ask again about {question.id}">Ask again</Button>
				{/if}
			{/if}
		</div>
	{/if}
{/snippet}

<div
	class="flex min-w-0 flex-col gap-2 {plain ? 'task-question' : 'rounded-2xl border px-3 py-2.5'} {plain ? '' : waitingForAgent
		? 'border-(--chat-border) bg-(--chat-surface)/50'
		: warning
		? 'border-(--chat-warning)/50 bg-(--chat-warning)/10'
		: 'border-(--accent-2)/40 bg-(--accent-2)/8'}"
	data-question={question.id}
	data-kind={warning ? 'warning' : 'question'}
>
	<div class="flex min-w-0 items-start gap-2">
		{#if warning}
			<TriangleAlertIcon class="mt-0.5 size-4 shrink-0 text-(--chat-warning)" aria-hidden="true" />
		{:else}
			<CircleHelpIcon class="mt-0.5 size-4 shrink-0 text-(--accent-2)" aria-hidden="true" />
		{/if}
		<div class="min-w-0 flex-1">
			<p class="text-xs text-(--chat-fg-subtle)">
				{#if askedBy}
					<span class="asked-by inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-px align-middle font-medium" data-asked-by
						><LayersIcon class="size-3 shrink-0" aria-hidden="true" /><span class="truncate">{askedBy}</span></span
					>
				{/if}
				{#if warning}<span class="font-semibold text-(--chat-warning)">Warning</span> ·{/if}
				<span class="font-mono">{question.id}</span>
				{#if taskLabel}
					·
					{#if taskHref}
						<a href={taskHref} class="break-words underline-offset-2 hover:text-(--chat-fg) hover:underline">{taskLabel}</a>
					{:else}
						<span class="break-words">{taskLabel}</span>
					{/if}
				{/if}
			</p>
			{#if strip && !optionsOnly}
				<button type="button" class="block min-h-11 w-full truncate text-left text-xs underline-offset-2 hover:underline" onclick={() => readingExpanded = true} title="Read the full question">{markdownText(question.text)}</button>
			{:else}<CardMarkdown source={question.text} />{/if}
			{#if turnWaiters.length}<p class="mt-1 text-xs text-(--chat-fg-muted)">Waiting for the landing turn: {turnWaiters.join(', ')}</p>{/if}
		</div>
		{#if !optionsOnly}
		<Dialog.Root bind:open={readingExpanded}>
			<Dialog.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="icon-sm" class="shrink-0" aria-label="Expand {warning ? 'warning' : 'question'} {question.id}" title="Expand {warning ? 'warning' : 'question'}">
						<Maximize2Icon class="size-4" aria-hidden="true" />
					</Button>
				{/snippet}
			</Dialog.Trigger>
			<Dialog.Content bind:ref={readingDialog} class="question-reading-dialog flex max-h-[90dvh] min-h-0 flex-col gap-3 p-4 sm:max-w-4xl sm:p-6" data-question-reading>
				<Dialog.Header class="shrink-0 pr-8">
					<Dialog.Title>{warning ? 'Warning' : 'Question'} {question.id}</Dialog.Title>
					<Dialog.Description class="max-h-10 overflow-y-auto">{taskLabel ?? (canAnswer && !warning ? 'Read the full text and answer below.' : 'Read the full text.')}</Dialog.Description>
				</Dialog.Header>
				<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to scroll the full text.) -->
				<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1" tabindex="0" role="region" aria-label="Full text of {question.id}">
					<Markdown source={question.text} userMessage class="question-reading-markdown" />
					{@render questionDiscussion()}
				</div>
				{#if canAnswer}
					<div class="flex shrink-0 flex-col gap-2 border-t border-(--chat-border) pt-3" data-question-answer-footer>
						{@render answerForm(true)}
					</div>
				{/if}
			</Dialog.Content>
		</Dialog.Root>
		{/if}
	</div>

	{#if !optionsOnly}{@render questionDiscussion()}{/if}
	{#if canAnswer}{@render answerForm(false)}{/if}
</div>

<style>
	@media (pointer: coarse) {
		.preview-option { min-height: 44px; }
	}

	:global(.question-reading-dialog) {
		top: var(--question-viewport-center, 50%);
		height: min(52rem, calc(var(--question-viewport-height, 100dvh) - 2rem));
		max-height: calc(var(--question-viewport-height, 100dvh) - 2rem);
	}

	:global(.question-answer-input) {
		max-height: min(6rem, calc(var(--question-viewport-height, 100dvh) * 0.2));
	}

	.question-answer-options {
		max-height: min(7rem, calc(var(--question-viewport-height, 100dvh) * 0.18));
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.question-answer-choices {
		max-height: min(16rem, calc(var(--question-viewport-height, 100dvh) * 0.32));
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	:global(.md.question-reading-markdown) {
		font-size: 1.125rem;
		line-height: 1.7;
	}

	.asked-by {
		color: var(--primary);
		background: color-mix(in oklab, var(--primary) 12%, transparent);
	}
</style>
