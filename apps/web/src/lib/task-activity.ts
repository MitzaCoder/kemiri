import type { BoardTask, BoardTaskActivity } from '@kemiri/protocol';
import { taskStateLabel } from './task-state.js';
import { relativeTime } from './relative-time.js';

export function taskActivitySupported(features: readonly string[] | undefined): boolean {
	return features?.includes('task-activity') ?? false;
}

export function automaticTaskActivity(task: BoardTask, enabled: boolean): BoardTaskActivity | undefined {
	return enabled ? task.activity : undefined;
}

/** Canonical text only: used by search and gists, never a locally formatted age. */
export function taskNowText(task: BoardTask, enabled: boolean): string {
	return automaticTaskActivity(task, enabled)?.text ?? task.report.now;
}

export function taskActivityAge(activity: BoardTaskActivity, now: number): string {
	if (activity.kind === 'unknown' || activity.kind === 'not_started') return '';
	// Delivery/state summaries may already include a verified “since” clock. Never add a second age.
	if (['delivery', 'waiting', 'review', 'done', 'dropped', 'idle'].includes(activity.kind) && /\bsince\b/i.test(activity.text)) return '';
	return relativeTime(activity.since, now);
}

export function taskActivityTone(kind: BoardTaskActivity['kind']): 'error' | 'attention' | 'active' | 'review' | 'muted' {
	if (kind === 'failure') return 'error';
	if (['question', 'feedback', 'blocked', 'waiting'].includes(kind)) return 'attention';
	if (kind === 'working' || kind === 'deploy') return 'active';
	if (kind === 'review') return 'review';
	return 'muted';
}

/** One compact state sentence. Typed activity kinds, not translated prose, decide redundancy. */
export function taskRowActivity(task: BoardTask, enabled: boolean, tasks: readonly BoardTask[] = []): BoardTaskActivity | undefined {
	const activity = automaticTaskActivity(task, enabled);
	const state = task.state;
	if (!state) return activity;
	const conveysState: Partial<Record<typeof state.kind, readonly BoardTaskActivity['kind'][]>> = {
		failed: ['failure'], answer_needed: ['question'], review: ['review'],
		working: ['working', 'deploy'], blocked_by_task: ['blocked'],
		waiting_outside: ['waiting'], done: ['done'], dropped: ['dropped'],
	};
	if (activity && conveysState[state.kind]?.includes(activity.kind)) return activity;
	return { kind: state.kind === 'todo' ? 'not_started' : 'idle', text: state.kind === 'failed' && task.blockedReason ? `Failed: ${task.blockedReason}` : taskStateLabel(task, tasks)!, since: state.since, refs: state.refs };
}
