<script lang="ts">
	import type { ProjectBoard } from '#lib/board.svelte.js';
	let { board }: { board: ProjectBoard | undefined } = $props();
	let dialog: HTMLDialogElement;
	$effect(() => {
		const question = board?.closeQuestion;
		if (!question || !dialog) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		dialog.showModal();
		dialog.querySelector<HTMLButtonElement>('[data-cancel-close]')?.focus();
		return () => {
			dialog.close();
			setTimeout(() => {
				const taskId = question.text.match(/^T\d+/)?.[0];
				const fallback = document.querySelector<HTMLElement>('[data-status-trigger]') ?? [...document.querySelectorAll<HTMLElement>('[data-card-menu]')].find(button => button.getAttribute('aria-label')?.startsWith(`Move ${taskId}:`));
				(fallback ?? (previous?.isConnected ? previous : undefined))?.focus();
			}, 0);
		};
	});
	function keydown(event: KeyboardEvent): void {
		if (board?.closeQuestion && event.key === 'Escape') {
			event.preventDefault();
			event.stopImmediatePropagation();
			board.closeQuestion.answer(undefined);
		}
	}
</script>

<svelte:window onkeydowncapture={keydown} />
<dialog bind:this={dialog} aria-labelledby="close-parts-title" aria-describedby="close-parts-question" oncancel={() => board?.closeQuestion?.answer(undefined)} class="pointer-events-auto m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-(--chat-border) bg-(--chat-surface) p-5 text-(--chat-fg) shadow-xl backdrop:bg-black/50" data-close-parts-dialog>
	<h2 id="close-parts-title" class="mb-2 text-base font-semibold">Close task</h2>
	<p id="close-parts-question" class="text-sm text-(--chat-fg-muted)">{board?.closeQuestion?.text ?? ''}</p>
	<div class="mt-5 flex flex-wrap justify-end gap-2">
		<button class="rounded-lg border border-(--chat-border) px-3 py-2 text-sm focus-visible:outline-2" onclick={() => board?.closeQuestion?.answer('close')}>Close them too</button>
		<button class="rounded-lg bg-(--accent-2) px-3 py-2 text-sm text-(--chat-bg) focus-visible:outline-2" onclick={() => board?.closeQuestion?.answer('follow_up')}>Keep as follow-ups</button>
		<button data-cancel-close class="rounded-lg border border-(--chat-border) px-3 py-2 text-sm focus-visible:outline-2" onclick={() => board?.closeQuestion?.answer(undefined)}>Cancel</button>
	</div>
</dialog>
