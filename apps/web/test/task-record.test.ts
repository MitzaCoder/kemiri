import { describe, expect, test } from 'bun:test';
import type { BoardDecision, BoardQuestion, BoardTaskSnapshot, BoardTimelineEntry, BoardTimelineGroup } from '@kemiri/protocol';
import { activityDays, activityText, taskActivityRows, taskDecided } from '../src/lib/task-record.js';

const asked = '2026-04-09T12:00:00Z';
const answered = '2026-04-10T14:00:00Z';
const later = '2026-04-10T15:00:00Z';
const user = { author: 'user', threadId: null, workerId: null } as const;
const question = (id: string, overrides: Partial<BoardQuestion> = {}): BoardQuestion => ({
	id, taskId: 'T1', text: 'How long should we keep it?', revision: 2, options: [], status: 'answered', answer: 'Three days', askedAt: asked, answeredAt: answered, ...overrides,
});
const decision = (id: string, why: string | null, overrides: Partial<BoardDecision> = {}): BoardDecision => ({
	id, taskId: 'T1', text: 'Keep the reservation for three days', at: answered, why, ...overrides,
});

describe('Decided', () => {
	test('uses explicit answer provenance in the reason or decision, and preserves independent rows', () => {
		const questions = [question('Q1'), question('Q2'), question('Q3')];
		const decisions = [decision('D1', "Ana’s answer to `Q1`: Three days"),
			decision('D2', 'Use the current policy', { text: 'Reply to question Q2: Do not accept payment' }), decision('D3', null)];
		const rows = taskDecided('T1', decisions, questions);
		expect(rows.map(row => [row.id, row.question?.id, row.why])).toEqual([
			['D1', 'Q1', undefined], ['D2', 'Q2', 'Use the current policy'], ['D3', undefined, undefined], ['Q3', 'Q3', undefined],
		]);
	});

	test('never guesses from identical wording, a bare mention, proximity, another task, or ambiguity', () => {
		const questions = [question('Q1'), question('Q11'), question('Q2', { taskId: 'T2' }),
			question('Q3', { status: 'open' }), question('Q4', { kind: 'warning' }), question('Q5'), question('Q6')];
		const decisions = [decision('D1', 'Wait for Q1'), decision('D2', 'Answer to Q2'), decision('D3', 'Answer to Q3'), decision('D4', 'Answer to Q4'),
			decision('D5', 'Answer to Q5 and Q6'), decision('D6', 'Answer to Q11', { at: asked }), decision('D7', 'Answer to Q6'), decision('D8', 'Answer to Q6')];
		const rows = taskDecided('T1', decisions, questions);
		expect(rows.filter(row => row.decision && row.question)).toEqual([]);
		expect(rows.filter(row => row.question).map(row => row.id)).toEqual(['Q1', 'Q11', 'Q5', 'Q6']);
	});
});

test('merges one snapshot, legacy worker episode and unmatched worker while omitting facts shown elsewhere', () => {
	const snapshot: BoardTaskSnapshot = { seq: 1, at: later, label: 'in_progress → review', title: 'Task', status: 'review', by: user, report: { now: '', results: '', next: '' } };
	const entries: BoardTimelineEntry[] = [
		{ kind: 'status', at: later, label: snapshot.label, ref: '1' },
		{ kind: 'question', at: asked, label: 'Question Q1' },
		{ kind: 'question', at: answered, label: 'Q2 answered', ref: 'Q2' },
		{ kind: 'decision', at: answered, label: 'Decision D1', ref: 'D1' },
		{ kind: 'worker', at: asked, label: 'Worker demo started', ref: 'demo' },
		{ kind: 'worker', at: answered, label: 'Worker demo reported', ref: 'demo', detail: 'Checked the work' },
		{ kind: 'worker', at: answered, label: 'Worker demo reported', ref: 'demo', detail: 'Checked the work' },
		{ kind: 'milestone', at: answered, label: '1 change landed on main', detail: 'Landed b4a1e00bad01 Add it' },
	];
	const rows = taskActivityRows({
		entries, snapshots: [snapshot], questions: [question('Q1', { status: 'open' }), question('Q2')],
		decisions: taskDecided('T1', [decision('D1', 'Answer to Q2')], [question('Q2')]), feedback: [], workers: [{ id: 'demo' }, { id: 'forgotten' }],
		now: { text: 'Checked the work', at: later }, deliveryShown: true,
	});
	expect(rows.map(row => row.label)).toEqual(['Working → review', 'Worker demo reported', 'forgotten · worker no longer available']);
	expect(rows[0]?.snapshot).toEqual(snapshot);
	expect(rows[1]?.at).toBe(answered);
	expect(activityDays(rows, 'newest', 1)[0]?.entries.map(row => row.at)).toEqual([later]);
	expect(activityDays(rows, 'oldest', 2)[0]?.entries.map(row => row.at)).toEqual([answered, later]);
	expect(activityText('Deployed `b4a1e00bad01`')).toBe('Deployed the commit');
});

test('orders a grouped episode by its outcome and folds the same running actor’s Now into it', () => {
	const actor = { id: 'run-a', kind: 'worker', name: 'demo', threadId: 'main', conversationId: 2, runId: 'run-a' } as const;
	const groups: BoardTimelineGroup[] = [{ id: 'group', kind: 'work', hour: asked, range: { start: asked, end: answered }, revision: 1, factCount: 1, label: 'Worker started', entries: [
		{ id: 'worker-run', kind: 'worker', label: 'Worker started', at: asked, endAt: answered, actor, group: 'work', outcome: 'running', revision: 1, factCount: 1 },
	] }];
	const rows = taskActivityRows({ groups, entries: [{ kind: 'worker', label: 'Worker demo started', ref: 'demo', at: asked }], snapshots: [], questions: [], decisions: [], feedback: [],
		workers: [{ id: 'demo' }], now: { text: 'Demo is checking the work', at: later, activity: { kind: 'working', text: 'Demo is checking the work', since: later, refs: [actor.id], actor } }, deliveryShown: false });
	expect(rows.map(row => [row.id, row.at, row.label, row.now])).toEqual([['worker-run', later, 'Demo is checking the work', true]]);
});
