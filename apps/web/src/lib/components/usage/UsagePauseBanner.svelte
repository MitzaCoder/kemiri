<script lang="ts">
	import { page } from '$app/state';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import { projectHref } from '#lib/backends.js';
	import Banner from '#lib/components/Banner.svelte';
	import { pauseWaitLabel, subscriptionProviderLabel } from '#lib/usage-glance.js';
	import UsagePauseAction from './UsagePauseAction.svelte';

	let { backend, onreopenquestion }: { backend: BackendConnection; onreopenquestion: (id: string) => void } = $props();
</script>

{#if backend.usagePauseLoaded}
	{#each backend.usagePauses as pause (pause.providerLogin)}
		{@const label = subscriptionProviderLabel(pause.providerLogin, backend.providers.find(provider => provider.id === pause.providerLogin)?.name)}
		<Banner tone="warning">
			<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
				<div>
					<p class="font-semibold">{label} work is paused on this computer.</p>
					<p>{pause.reason} {pauseWaitLabel(pause)}</p>
					{#if pause.drain?.status === 'investigating'}
						<p>Kemiri is looking into the fast drain.</p>
					{:else if pause.drain?.status === 'needs-choice'}
						<p>Kemiri needs a choice before resuming.</p>
					{:else if pause.drain?.status === 'kept-paused'}
						<p>Work will stay paused until resumed.</p>
					{/if}
				</div>
				{#if pause.drain?.status === 'needs-choice' && pause.drain.projectId && pause.drain.questionId}
					{@const questionId = pause.drain.questionId}
					{@const href = `${projectHref(backend.id, pause.drain.projectId)}?question=${encodeURIComponent(questionId)}`}
					<a class="rounded-md border border-current px-3 py-1.5 font-medium hover:underline" {href} onclick={(event) => {
						if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && href === page.url.pathname + page.url.search) {
							event.preventDefault();
							onreopenquestion(questionId);
						}
					}}>Open question</a>
				{:else if !pause.drain || pause.drain.status === 'kept-paused'}
					<UsagePauseAction {backend} providerLogin={pause.providerLogin} {label} />
				{/if}
			</div>
		</Banner>
	{/each}
{/if}
