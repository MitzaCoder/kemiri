import { expect, test } from 'bun:test';
import { createServer } from 'vite';
import type { BoardTask } from '@kemiri/protocol';

// Render the actual list metadata and board card: a second kind label must not return.
test('list metadata and board cards render one state sentence with a derived-colour dot', async () => {
	const vite = await createServer({ root: import.meta.dir + '/..', server: { middlewareMode: true }, logLevel: 'error' });
	try {
		const { default: TaskCard } = await vite.ssrLoadModule('/src/lib/components/TaskCard.svelte');
		const { default: TaskFamilyMeta } = await vite.ssrLoadModule('/src/lib/components/TaskFamilyMeta.svelte');
		const { taskRowActivity } = await vite.ssrLoadModule('/src/lib/task-activity.ts');
		const { render } = await vite.ssrLoadModule('svelte/server');
		for (const [kind, activityKind, sentence, duplicate] of [
			['answer_needed', 'question', 'Waiting for your answer to Q1', 'Answer needed'],
			['review', 'review', 'Ready for your review', 'Ready for review'],
			['paused', 'idle', 'Idle', 'Idle'],
			['blocked_by_task', 'blocked', 'Blocked by T7', 'Waits for'],
		] as const) {
			const since = '2026-11-01T10:00:00Z';
			const task = {
				id: 'T1', title: 'Choose the packaging', status: 'todo', order: 1, blockedBy: [], workerIds: [], refs: [],
				parent: null, foundWhile: null, related: [], settledAt: null, createdAt: since, updatedAt: since,
				report: { now: '', results: '', next: '', revision: 1, updatedAt: null, updatedBy: null },
				state: { group: kind === 'paused' ? 'in_progress' : kind === 'blocked_by_task' ? 'waiting' : 'needs_you', kind, since, refs: ['T7'] },
				activity: { kind: activityKind, text: sentence, since, refs: ['Q1'] },
			} as unknown as BoardTask;
			const activity = taskRowActivity(task, true);
			const card = render(TaskCard, { props: { card: { task, waiting: [], column: task.state!.group }, tasks: [task], now: Date.parse(since), href: '#T1', activityEnabled: true } }).body;
			const metadata = render(TaskFamilyMeta, { props: { task, tasks: [task], nested: false, taskHref: (id: string) => `#${id}`, activity } }).body;
			for (const html of [card, metadata]) {
				expect(html).not.toContain(duplicate);
				expect(html.match(/class="activity-line /g)?.length).toBe(1);
				expect(html).toContain('var(--task-status)');
				expect(html).toContain(kind === 'paused' ? 'Paused' : sentence);
			}
		}
	} finally { await vite.close(); }
}, 20000);
