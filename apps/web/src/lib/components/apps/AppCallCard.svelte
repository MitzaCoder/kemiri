<script lang="ts">
	import type { ToolPart } from '#lib/transcript.js';
	import { appIdFromCall } from '#lib/agent-apps.js';
	import { projectApps } from '#lib/agent-apps.svelte.js';
	import PublishedAppRow from './PublishedAppRow.svelte';
	import ToolCard from '#lib/components/chat/ToolCard.svelte';

	let { part, cwd }: { part: ToolPart; cwd?: string } = $props();
	const apps = projectApps();
	const appId = $derived(appIdFromCall(part));
	const app = $derived(apps?.current?.apps.find(record => record.appId === appId));
</script>

{#if app}
	<div class="my-2 rounded-xl border border-(--chat-border) bg-(--chat-surface) p-3" data-app-call>
		<PublishedAppRow {app} />
	</div>
{:else if appId && apps}
	<div class="my-2 rounded-xl border border-(--chat-border) p-3 text-sm text-(--chat-fg-muted)">
		{apps.current?.loaded ? 'This app is no longer recorded.' : apps.current?.error ?? 'App status unavailable until the backend is connected.'}
	</div>
{:else}
	<ToolCard {part} {cwd} />
{/if}
