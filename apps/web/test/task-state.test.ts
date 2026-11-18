import { taskRowActivity } from '../src/lib/task-activity.ts';
import { describe, expect, test } from 'bun:test';
import type { BoardTask, BoardTaskInput } from '@kemiri/protocol';
import { taskSections, taskSectionOf } from '../src/lib/tasks.ts';
import { columnOfTask, dropTarget, kanbanColumns, moveChoices, needsYouCount } from '../src/lib/kanban.ts';
import { taskStateLabel, taskWithStateSupport, taskStateSupported, graphTaskState } from '../src/lib/task-state.ts';
import { taskFamilies } from '../src/lib/task-families.ts';
import { buildTaskGraph } from '../src/lib/task-graph.ts';
import { buildGraphModel } from '../src/lib/task-graph-model.ts';
import { closePartsQuestion, openDirectParts, saveWithCloseChoice, type OpenPartsChoice, type TaskSaveOptions } from '../src/lib/task-close.ts';

function task(id: string, kind: NonNullable<BoardTask['state']>['kind'] = 'todo', since = '2026-11-01T10:00:00Z', overrides: Partial<BoardTask> = {}): BoardTask {
	const group = ['failed', 'answer_needed', 'steps_needed', 'review'].includes(kind) ? 'needs_you' : ['working', 'paused'].includes(kind) ? 'in_progress' : ['blocked_by_task', 'waiting_outside'].includes(kind) ? 'waiting' : ['done', 'dropped'].includes(kind) ? 'closed' : 'todo';
	return { id, revision: 1, title: `Bakery ${id}`, status: 'todo', description: '', acceptance: null, blockedBy: [], blockedReason: null, writeScopes: [], workerIds: [], order: Number(id.slice(1)), parent: null, report: { now: '', next: '', results: '', revision: 1, updatedAt: null, updatedBy: null }, createdAt: since, updatedAt: since, settledAt: null, archived: false, state: { group, kind, since, refs: [] }, ...overrides } as BoardTask;
}
const input = (status: BoardTaskInput['status']): BoardTaskInput => ({ title: 'Bakery task', status, description: '', acceptance: null, blockedBy: [], blockedReason: null, writeScopes: [] });

describe('derived task states', () => {
	test('list and board share groups and kind/age/priority sorting', () => {
		const tasks = [task('T1', 'review'), task('T2', 'answer_needed'), task('T3', 'failed', '2026-11-01T12:00:00Z'), task('T4', 'failed'), task('T5', 'paused'), task('T6', 'working'), task('T7', 'working', '2026-10-31T10:00:00Z'), task('T8', 'blocked_by_task'), task('T9', 'waiting_outside', '2026-10-31T10:00:00Z'), task('T11'), task('T10'), task('T12', 'done'), task('T13', 'dropped', '2026-11-02T10:00:00Z'), task('T14', 'steps_needed')];
		const board = { tasks, questions: [] };
		const sections = taskSections(board);
		expect(sections.map(s => s.id)).toEqual(['needs_you', 'in_progress', 'waiting', 'todo', 'closed']);
		expect(sections.map(s => s.rows.map(row => row.task.id))).toEqual([['T4', 'T3', 'T2', 'T14', 'T1'], ['T7', 'T6', 'T5'], ['T9', 'T8'], ['T10', 'T11'], ['T13', 'T12']]);
		const columns = kanbanColumns(board, { stateEnabled: true });
		expect(columns.map(c => c.label)).toEqual(['Needs you', 'In progress', 'Waiting', 'To do', 'Closed']);
		expect(columns.map(c => c.cards.map(card => card.task.id))).toEqual(sections.map(s => s.rows.map(row => row.task.id)));
		expect(needsYouCount(board)).toBe(5);
		expect(kanbanColumns(board, { stateEnabled: true, onlyNeedsYou: true }).flatMap(c => c.cards).length).toBe(5);
		expect(sections.at(-1)?.collapsedByDefault).toBe(true);
	});
	test('missing capability strips the field; missing field keeps the original status groups', () => {
		expect(taskStateSupported(undefined)).toBe(false);
		expect(taskStateSupported(['task-activity'])).toBe(false);
		expect(taskStateSupported(['task-state'])).toBe(true);
		const legacy = taskWithStateSupport(task('T1', 'failed', undefined, { status: 'in_progress' }), false);
		expect(legacy.state).toBeUndefined();
		expect(kanbanColumns({ tasks: [task('T1', 'failed')], questions: [] }, { stateEnabled: false }).find(c => c.id === 'todo')?.cards.length).toBe(1);
		expect(taskSectionOf(legacy, 0)).toBe('working');
		expect(columnOfTask(legacy)).toBe('working');
		expect(kanbanColumns({ tasks: [legacy], questions: [] }, { stateEnabled: true }).map(c => c.id)).toEqual(['todo', 'working', 'blocked', 'review', 'waiting', 'done']);
	});
	test('new columns refuse bare attention/waiting drops and offer only owner move targets', () => {
		expect(dropTarget('needs_you')).toBeUndefined(); expect(dropTarget('waiting')).toBeUndefined();
		expect(dropTarget('in_progress')).toBe('in_progress'); expect(dropTarget('todo')).toBe('todo');
		expect(dropTarget('closed')).toBe('done'); expect(dropTarget('closed', true)).toBe('dropped');
		expect(moveChoices('todo', true).map(c => c.target)).toEqual(['in_progress', 'done', 'dropped']);
		expect(moveChoices('todo').map(c => c.target)).toContain('blocked');
		expect(moveChoices('in_progress', true, 'needs_you').map(c => c.target)).toEqual(['todo', 'in_progress', 'done', 'dropped']);
		expect(moveChoices('todo', true, 'waiting').map(c => c.target)).toEqual(['todo', 'in_progress', 'done', 'dropped']);
		expect(kanbanColumns({ tasks: [], questions: [] }, { stateEnabled: true }).map(c => c.id)).toEqual(['needs_you', 'in_progress', 'waiting', 'todo', 'closed']);
	});
	test('families compare derived group, and attention descendants cannot disappear', () => {
		const parent = task('T1', 'working', undefined, { status: 'in_progress' });
		const child = task('T2', 'paused', undefined, { parent: 'T1' });
		const section = taskSections({ tasks: [parent, child], questions: [] })[0]!;
		expect(taskFamilies(section, {})[0]?.foldedCount).toBe(1);
		expect(taskFamilies(section, { T1: true })[0]?.children[0]?.row.task.id).toBe('T2');
		const waiting = task('T3', 'blocked_by_task', undefined, { parent: 'T1' });
		expect(taskSections({ tasks: [parent, waiting], questions: [] }).map(s => s.rows.map(r => r.task.id))).toEqual([['T1'], ['T3']]);
	});
	test('labels name failures, answers, paused time and blockers without changing stored statuses', () => {
		expect(taskStateLabel(task('T1', 'paused'))).toBe('Paused');
		expect(taskStateLabel(task('T1', 'failed'))).toBe('Failed');
		expect(taskStateLabel(task('T1', 'answer_needed'))).toBe('Answer needed');
		const blocked = task('T1', 'blocked_by_task'); blocked.state!.refs = ['T7'];
		expect(taskStateLabel(blocked, [{ id: 'T7', title: 'Repair the oven' }])).toBe('Blocked by T7 Repair the oven');
	});
	test('graph maps state colour keys and attention reasons, preserving legacy exports', () => {
		const tasks = ['failed', 'answer_needed', 'steps_needed', 'review', 'working', 'paused', 'blocked_by_task'].map((kind, i) => task(`T${i + 1}`, kind as NonNullable<BoardTask['state']>['kind']));
		expect(tasks.map(graphTaskState)).toEqual(['failed', 'answer_needed', 'steps_needed', 'review', 'working', 'paused', 'blocked_by_task']);
		expect(buildTaskGraph(tasks, [], [], []).nodes.map(n => n.attention)).toEqual([true, true, true, true, false, false, false]);
		const model = buildGraphModel(tasks, [], [], [], Date.now());
		expect([...model.details.values()].map(d => d.reasons)).toEqual([['failed'], ['question'], ['steps'], ['review'], [], [], ['waiting']]);
	});
});

describe('close-parent choice on every save path', () => {
	for (const status of ['done', 'dropped'] as const) for (const choice of ['close', 'follow_up', undefined] as const) test(`${status}: ${choice ?? 'cancel'}`, async () => {
		const tasks = [task('T5'), task('T6', 'todo', undefined, { parent: 'T5' }), task('T7', 'review', undefined, { parent: 'T5', status: 'review' }), task('T8', 'done', undefined, { parent: 'T5', status: 'done' }), task('T9', 'todo', undefined, { parent: 'T6' })];
		expect(openDirectParts(tasks, 'T5').map(t => t.id)).toEqual(['T6', 'T7']);
		const calls: TaskSaveOptions[] = [];
		const outcome = await saveWithCloseChoice(input(status), { taskId: 'T5' }, { enabled: true, tasks: () => tasks, refresh: async () => {}, ask: async text => { expect(text).toBe('T5 has 2 open parts: T6 (to do), T7 (in review). What should happen to them?'); return choice; }, save: async (_, options) => { calls.push(options); return tasks[0]!; } });
		expect(outcome.kind).toBe(choice ? 'saved' : 'cancelled');
		expect(calls.length).toBe(choice ? 1 : 0);
		if (choice) { expect(calls[0]?.openParts).toBe(choice); expect('closedParts' in outcome && outcome.closedParts).toBe(true); }
	});
	for (const choice of ['close', 'follow_up', undefined] as const) test(`stale open_parts error: ${choice ?? 'cancel'}`, async () => {
		let tasks = [task('T5')], attempts = 0, asked = 0;
		const options: TaskSaveOptions[] = [];
		const outcome = await saveWithCloseChoice(input('done'), { taskId: 'T5', expectedRevision: 1 }, { enabled: true, tasks: () => tasks, refresh: async () => { tasks = [task('T5', 'todo', undefined, { revision: 2 }), task('T6', 'todo', undefined, { parent: 'T5' })]; }, ask: async text => { asked++; expect(text).toBe(closePartsQuestion('T5', [tasks[1]!])); return choice; }, save: async (_, option) => { attempts++; options.push(option); if (attempts === 1) throw { code: 'open_parts', message: 'T5 has open parts' }; return tasks[0]!; } });
		expect(asked).toBe(1); expect(attempts).toBe(choice ? 2 : 1);
		expect(outcome.kind).toBe(choice ? 'saved' : 'cancelled');
		if (choice) expect(options[1]).toMatchObject({ expectedRevision: 2, openParts: choice });
	});
	test('old backend never asks and normal failures still reach the caller', async () => {
		let asks = 0;
		const context = { enabled: false, tasks: () => [task('T6', 'todo', undefined, { parent: 'T5' })], refresh: async () => {}, ask: async () => { asks++; return 'close' as OpenPartsChoice; }, save: async () => task('T5') };
		expect((await saveWithCloseChoice(input('done'), { taskId: 'T5' }, context)).kind).toBe('saved'); expect(asks).toBe(0);
		await expect(saveWithCloseChoice(input('done'), { taskId: 'T5' }, { ...context, save: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
	});
});


describe('one state sentence per compact row/card', () => {
	const cases = [
		['failed', 'Failed'], ['answer_needed', 'Answer needed'], ['steps_needed', 'Your steps'], ['review', 'Ready for review'],
		['working', 'Working'], ['paused', 'Paused'], ['blocked_by_task', 'Blocked by T7'],
		['waiting_outside', 'Waiting'], ['todo', 'To do'], ['done', 'Done'], ['dropped', 'Dropped'],
	] as const;
	for (const [kind, text] of cases) test(`${kind}: fallback beats absent or unrelated activity`, () => {
		const row = task('T1', kind); row.state!.refs = ['T7'];
		expect(taskRowActivity(row, false)?.text).toBe(text);
		row.activity = { kind: 'unknown', text: 'Unrelated old activity', since: row.createdAt, refs: [] };
		expect(taskRowActivity(row, true)?.text).toBe(text);
		expect(taskRowActivity(row, true)?.since).toBe(row.state!.since);
	});
	for (const [kind, activityKind] of [['failed', 'failure'], ['answer_needed', 'question'], ['review', 'review'], ['working', 'working'], ['working', 'deploy'], ['blocked_by_task', 'blocked'], ['waiting_outside', 'waiting'], ['done', 'done'], ['dropped', 'dropped']] as const) test(`${kind}/${activityKind}: keep the single detailed sentence`, () => {
		const row = task('T1', kind, undefined, { activity: { kind: activityKind, text: 'Canonical sentence with detail', since: '2026-11-02T10:00:00Z', refs: ['Q1'] } });
		expect(taskRowActivity(row, true)).toBe(row.activity);
	});
	test('paused replaces idle; failures retain their reason; blockers resolve titles without activity', () => {
		const row = task('T1', 'paused', undefined, { activity: { kind: 'idle', text: 'Idle', since: '2026-11-01T09:00:00Z', refs: [] } });
		expect(taskRowActivity(row, true)?.text).toBe('Paused');
		expect(taskRowActivity(task('T1', 'failed', undefined, { blockedReason: 'Printer disconnected' }), true)?.text).toBe('Failed: Printer disconnected');
		const blocked = task('T1', 'blocked_by_task'); blocked.state!.refs = ['T7'];
		expect(taskRowActivity(blocked, true, [task('T7', 'working', undefined, { title: 'Repair the oven' })])?.text).toBe('Blocked by T7 Repair the oven');
	});
	test('unadvertised state and activity keep legacy gates', () => {
		const row = taskWithStateSupport(task('T1', 'paused', undefined, { activity: { kind: 'idle', text: 'Idle', since: '2026-11-01T09:00:00Z', refs: [] } }), false);
		expect(taskRowActivity(row, false)).toBeUndefined();
		expect(taskRowActivity(row, true)).toBe(row.activity);
	});
});
