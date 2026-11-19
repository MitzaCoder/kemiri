<script lang="ts">
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import type { HarnessClient } from '@kemiri/client';
	import type { UsageTaskResponse } from '@kemiri/protocol';
	import { bindingShareText, taskUsagePresentation, usageDollars } from '#lib/task-usage.js';

	let { client, projectId, taskId }: { client: HarnessClient; projectId: string; taskId: string } = $props();
	let usage = $state<UsageTaskResponse>();
	const presentation = $derived(taskUsagePresentation(usage, taskId));

	$effect(() => {
		let viewingTask = true;
		void client.readTaskUsage(projectId, taskId).then(answer => {
			if (viewingTask) usage = answer;
		}, () => {});
		return () => { viewingTask = false; };
	});
</script>

{#if usage && presentation}
	<details class="task-usage">
		<summary><ChevronRight size={15} aria-hidden="true" /><span>{presentation.headline}</span></summary>
		<div class="breakdown">
			<dl>
				<div class="amount"><dt>This task</dt><dd>{presentation.ownCost}</dd></div>
				<div class="amount"><dt>Subtasks</dt><dd>{presentation.subtaskCost}</dd></div>
				{#each presentation.parts as part (part.taskId)}
					<div class="amount part" style:padding-inline-start={`${Math.min(part.depth + 1, 6)}rem`}>
						<dt><span class="task-id">{part.taskId}</span> {part.title}</dt><dd>{usageDollars(part.total.apiValue)}</dd>
					</div>
				{/each}
			</dl>
			{#if usage.subscriptions.length}
				<div>
					<h3>By subscription</h3>
					<dl>
						{#each usage.subscriptions as subscription (`${subscription.providerId}/${subscription.billing}`)}
							<div class="amount">
								<dt>{subscription.label}<small>{bindingShareText(subscription) ?? ''}{subscription.bindingWindow ? ' · ' : ''}paid for by subscription</small></dt>
								<dd>{usageDollars(subscription.apiValue)}</dd>
							</div>
						{/each}
					</dl>
				</div>
			{/if}
			{#if presentation.paidAtApiPrices}<p>Paid at API prices: <strong>{presentation.paidAtApiPrices}</strong></p>{/if}
			{#if usage.conversations.length}
				<div>
					<h3>By worker or thread</h3>
					<dl>
						{#each usage.conversations as conversation (JSON.stringify([conversation.workerId, conversation.threadId, conversation.providerId, conversation.model]))}
							<div class="amount">
								<dt>{conversation.name}<small>{conversation.kind} · {conversation.model}</small></dt><dd>{usageDollars(conversation.apiValue)}</dd>
							</div>
						{/each}
					</dl>
				</div>
			{/if}
			{#each presentation.notes as note (note)}<p class="note">{note}</p>{/each}
		</div>
	</details>
{/if}

<style>
	.task-usage { font-size: 0.875rem; }
	summary { display: flex; align-items: center; gap: 0.375rem; min-height: 2.75rem; color: var(--chat-fg-muted); cursor: pointer; list-style: none; }
	summary::-webkit-details-marker { display: none; }
	summary:hover { color: var(--chat-fg); }
	summary :global(svg) { flex: none; }
	details[open] summary :global(svg) { transform: rotate(90deg); }
	.breakdown { border-top: 1px solid var(--chat-border); padding: 0.65rem 0 0.2rem 1.3rem; display: grid; gap: 0.65rem; }
	.amount { display: flex; justify-content: space-between; gap: 0.75rem; padding-block: 0.15rem; }
	dt { min-width: 0; overflow-wrap: anywhere; }
	dd { font-variant-numeric: tabular-nums; white-space: nowrap; }
	h3 { font-size: inherit; font-weight: 600; }
	small, .note, .task-id { color: var(--chat-fg-muted); }
	small { display: block; font-size: 0.75rem; }
	.task-id { white-space: nowrap; }
</style>
