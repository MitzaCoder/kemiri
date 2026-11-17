<script lang="ts">
	import type { BoardTaskActivity } from '@kemiri/protocol';
	import { activityMinute } from '#lib/activity-minute.js';
	import { taskActivityAge } from '#lib/task-activity.js';
	import { exactTime } from '#lib/relative-time.js';
	let { activity, compact = false, stateTone }: { activity: BoardTaskActivity; compact?: boolean; stateTone?: string } = $props();
	const age = $derived(taskActivityAge(activity, $activityMinute));
</script>

<span class="activity-line {stateTone ?? ''} inline-flex max-w-full items-start gap-1.5" class:text-task={ !compact } class:text-task-sm={compact} data-activity-kind={activity.kind}>
	<span class="min-w-0 break-words text-(--chat-fg-muted)">{activity.text}{#if age}<span class="text-[0.6875rem] text-(--chat-fg-subtle)" title={exactTime(activity.since)}>{activity.agePrefix ?? ' · '}{age}</span>{/if}</span>
</span>

