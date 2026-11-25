import { expect, it } from 'bun:test';
import type { BoardTask, BoardQuestion } from '@kemiri/protocol';
import { taskState, type TaskActivityTracking } from '../src/task-activity.ts';

const since = '2026-01-01T12:00:00.000Z';
const now = Date.parse(since) + 3 * 3600_000;
const task = (extra: Partial<BoardTask> = {}): BoardTask => ({ id: 'T1', title: 'Choose the box supplier', status: 'todo', blockedBy: [], updatedAt: since, createdAt: since, ...extra }) as BoardTask;
const question = (id: string, text: string): BoardQuestion => ({ id, text, status: 'open', kind: 'question', taskId: 'T1', askedAt: since }) as BoardQuestion;
function sentence(t: BoardTask, tasks: BoardTask[] = [t], questions: BoardQuestion[] = [], tracking?: TaskActivityTracking) {
 return taskState(t, questions, tasks, tracking, now).sentence!;
}

it('uses question text, normalizes whitespace, truncates and counts remaining questions', () => {
 const t = task();
 expect(sentence(t, [t], [question('Q1', 'Paper boxes\nor tins?')])).toMatchObject({ text: 'Answer needed: Paper boxes or tins?', ageFormat: 'none', refs: ['Q1'] });
 expect(sentence(t, [t], [question('Q1', 'Paper boxes or tins?'), question('Q2', 'Which colour?')]).text).toBe('Answer needed: Paper boxes or tins? and 1 more');
 expect(sentence(t, [t], [question('Q1', 'x'.repeat(200))]).text).toBe('Answer needed: ' + 'x'.repeat(159) + '…');
});
it('names the first open blocker, its title and remaining count, without an age', () => {
 const t = task({ blockedBy: ['T5', 'T7', 'T8'] });
 const tasks = [t, task({ id: 'T5', status: 'done' }), task({ id: 'T7', title: 'Repair the big oven' }), task({ id: 'T8' })];
 expect(sentence(t, tasks)).toMatchObject({ text: 'Blocked by T7 Repair the big oven and 1 more', refs: ['T7', 'T8'], ageFormat: 'none' });
});
it('paused duration starts at the last quiet time, not the 15-minute pause threshold', () => {
 const t = task({ status: 'in_progress' });
 const state = taskState(t, [], [t], { sources: {}, lastEndedAt: since }, now);
 expect(taskState(t, [], [t], undefined, now)).toMatchObject({ kind: 'paused', since });
 expect(state.since).toBe('2026-01-01T12:15:00.000Z');
 expect(state.sentence).toMatchObject({ text: 'Paused', since, ageFormat: 'duration', agePrefix: ' · nothing has run on it for ' });
});
it('working uses the reported phase or just working, never repeats the task title', () => {
 const t = task({ status: 'in_progress' });
 const tracking: TaskActivityTracking = { sources: { run: { actor: { id: 'run', kind: 'worker', name: 'moss', threadId: 'main', conversationId: 1, runId: '1' }, state: 'running', title: t.title, since } } };
 expect(sentence(t, [t], [], tracking)).toMatchObject({ text: 'moss is working', since, ageFormat: 'duration' });
 tracking.sources.run!.phase = 'testing the thermostat';
 expect(sentence(t, [t], [], tracking).text).toBe('moss is testing the thermostat');
 tracking.sources.run!.state = 'failed'; tracking.sources.run!.failure = 'The repair failed twice.';
 expect(sentence(t, [t], [], tracking).text).toBe('Failed: moss failed: The repair failed twice.');
});
it('clarifying uses the asking agent sentence, including while another run is live', () => {
 const t = task();
 const q = { ...question('Q1', 'Paper boxes or tins?'), waitingOn: 'agent' as const, threadId: 'main' };
 expect(sentence(t, [t], [q])).toMatchObject({ text: 'Coordinator is clarifying Q1', ageFormat: 'duration' });
 const tracking: TaskActivityTracking = { sources: { run: { actor: { id: 'run', kind: 'worker', name: 'moss', threadId: 'main', conversationId: 1, runId: '1' }, state: 'running', title: t.title, since } } };
 expect(taskState(t, [q], [t], tracking, now)).toMatchObject({ kind: 'clarifying',
  sentence: { text: 'Coordinator is clarifying Q1' }, runningWork: { text: 'moss is working' } });
});
it('todo and follow-ups have no age; review, waiting and closed keep one explicit state', () => {
 expect(sentence(task())).toMatchObject({ text: 'Not started', ageFormat: 'none' });
 const follow = task({ foundWhile: 'T5' });
 expect(sentence(follow, [follow, task({ id: 'T5', status: 'done' })]).text).toBe('Not started · follow-up of T5 (done)');
 expect(sentence(task({ status: 'review' })).text).toBe('Ready for review');
 for (const note of ['the mill to confirm delivery', 'Waiting for the mill to confirm delivery']) {
  expect(sentence(task({ status: 'waiting', waiting: { note, since } } as Partial<BoardTask>)).text).toBe('Waiting for the mill to confirm delivery');
 }
 expect(sentence(task({ status: 'blocked', blockedReason: 'The repair run failed twice.' })).text).toBe('Failed: The repair run failed twice.');
 expect(sentence(task({ status: 'done' })).text).toBe('Done');
 expect(sentence(task({ status: 'dropped' })).text).toBe('Dropped');
});
