<script lang="ts">
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import { visibleApps } from '#lib/agent-apps.js';
	import { useProjectApps } from '#lib/agent-apps.svelte.js';
	import PublishedAppRow from './PublishedAppRow.svelte';

	let { backend, projectId, taskId }: { backend: BackendConnection; projectId: string; taskId: string } = $props();
	const apps = useProjectApps(() => backend.features?.includes('apps') ? { client: backend.client, projectId } : undefined);
	const rows = $derived(visibleApps(apps.current?.apps ?? [], taskId));
</script>

{#if rows.length}
	<section aria-label="Apps">
		<h3 class="task-detail-heading mb-1">Apps</h3>
		<ul class="divide-y divide-(--chat-border) rounded-lg border border-(--chat-border)">
			{#each rows as app (app.appId)}
				<li class="p-3"><PublishedAppRow {app} detail={`port ${app.port}`} update={action => apps.current!.update(app.appId, action)} /></li>
			{/each}
		</ul>
	</section>
{/if}
