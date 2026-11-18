import { expect, test } from 'bun:test';
import { createServer } from 'vite';
import { taskPartProgress, taskUsesPartsSentence } from '../src/lib/task-parts.js';
import { taskWithStateSupport } from '../src/lib/task-state.js';
import type { BoardTask } from '@kemiri/protocol';

const parent = (states?: BoardTask['subtaskStates']) => ({ id: 'T1', status: 'in_progress', parent: null, foundWhile: null, related: [], blockedBy: [], refs: [], subtaskCount: { done: 1, total: 3 }, subtaskStates: states, state: { group: 'in_progress', kind: 'working', since: '2026-11-12T12:00:00Z', refs: ['T3'] } }) as BoardTask;

test('parts are ordered done, working, needs-you, rest; dropped and zero counts stay out', () => {
	const progress = taskPartProgress(parent(['todo', 'review', 'working', 'done', 'failed', 'dropped', 'steps_needed']))!;
	expect(progress.text).toBe('1 of 6 parts done · 1 working · 3 needs you');
	expect(progress.segments.map(segment => segment.tone)).toEqual(['done', 'working', 'needs-you', 'needs-you', 'needs-you', 'other']);
	expect(taskPartProgress(parent(['todo']))!.text).toBe('0 of 1 parts done');
	expect(taskPartProgress(parent())).toBeUndefined();
	expect(taskPartProgress(parent([]))).toBeUndefined();
});

test('twelve parts have individual segments; thirteen use proportional shares', () => {
	expect(taskPartProgress(parent(Array(12).fill('todo')))!.segments).toHaveLength(12);
	const progress = taskPartProgress(parent(['done', ...Array(12).fill('todo')]))!;
	expect(progress.proportional).toBe(true);
	expect(progress.segments).toEqual([{ tone: 'done', count: 1 }, { tone: 'other', count: 12 }]);
});

test('own attention and waiting keep their sentence; unadvertised parts retain the ring', () => {
	const task = parent(['done', 'working', 'todo']);
	expect(taskUsesPartsSentence(task)).toBe(true);
	for (const group of ['needs_you', 'waiting', 'closed'] as const) expect(taskUsesPartsSentence({ ...task, state: { ...task.state!, group } })).toBe(false);
	expect(taskWithStateSupport(task, true).subtaskStates).toBeUndefined();
	expect(taskWithStateSupport(task, true, true).subtaskStates).toEqual(task.subtaskStates);
});

test('real metadata renders one parts sentence and native expanded disclosure, or the legacy ring', async () => {
	const vite = await createServer({ root: import.meta.dir + '/..', server: { middlewareMode: true }, logLevel: 'error' });
	try {
		const { default: TaskFamilyMeta } = await vite.ssrLoadModule('/src/lib/components/TaskFamilyMeta.svelte');
		const { render } = await vite.ssrLoadModule('svelte/server');
		for (const states of [undefined, ['done', 'working', 'todo']] as const) {
			const task = parent(states ? [...states] : undefined);
			const html = render(TaskFamilyMeta, { props: { task, tasks: [task], nested: false, taskHref: () => '#T1', activity: { kind: 'working', text: '1 of 3 parts done · 1 working', since: task.state!.since, refs: [] }, canToggle: true, expanded: false } }).body;
			expect(html).toContain('<button');
			expect(html).toContain('aria-expanded="false"');
			if (states) {
				expect(html.match(/class="activity-line /g)).toBeNull();
				expect(html).toContain('parts-bar');
				expect(html).not.toContain('<circle');
			} else expect(html).toContain('<circle');
		}
	} finally { await vite.close(); }
}, 20000);
