import { describe, expect, test } from 'bun:test';
import type { BoardQuestion, BoardReportCheck, BoardTask, BoardTaskStatus } from '@kemiri/protocol';
import { acceptanceMarkdown, failedCheckLine, questionAnswers, readTaskRecordFold, saveTaskRecordFold, taskDetailFields, taskDetailState, taskNeedsYou, taskNextPlacement } from '../src/lib/task-details.js';

const task = (status: BoardTaskStatus, blockedReason: string | null = null) => ({ id: 'T1', status, blockedReason });
const question: BoardQuestion = {
	id: 'Q1', revision: 1, kind: 'question', text: 'When should the shop open?', options: [], taskId: 'T1',
	status: 'open', answer: null, askedAt: '2026-01-01T00:00:00Z', answeredAt: null,
};

describe('Needs you', () => {
	test('only open questions and warnings for the current task and waiting for the owner go in the block', () => {
		const warning = { ...question, id: 'Q2', kind: 'warning' } as const;
		const forAgent = { ...question, id: 'Q3', waitingOn: 'agent' } as const;
		const needs = taskNeedsYou(task('in_progress'), [
			question, warning, forAgent, { ...question, id: 'Q4', status: 'answered' }, { ...question, id: 'Q5', taskId: 'T2' },
		], false, false);
		expect(needs.ownerQuestions).toEqual([warning, question]);
		expect(needs.questionsForAgent).toEqual([forAgent]);
		expect(needs.show).toBe(true);
		expect(taskDetailState('in_progress', needs)).toBe('Needs your answer');
		expect(taskNeedsYou(task('in_progress'), [forAgent], false, false).show).toBe(false);
	});

	test('review always offers the check, and a blocked task can show a reason or a blocker', () => {
		expect(taskNeedsYou(task('review'), [], false, false)).toMatchObject({ review: true, blocked: false, show: true });
		expect(taskNeedsYou(task('blocked', 'Waiting for a part'), [], false, false)).toMatchObject({ blocked: true, show: true });
		expect(taskNeedsYou(task('blocked'), [], true, false).show).toBe(true);
		expect(taskNeedsYou(task('blocked', ' '), [], false, false).show).toBe(false);
		expect(taskNeedsYou(task('done', 'Old reason'), [], true, false).show).toBe(false);
	});

	test('shows non-empty steps only for a supported open task, preserving numbered Markdown', () => {
		const steps = '1. Open Settings.\n2. Set the code to `30`.';
		const withSteps = { ...task('in_progress'), report: { steps } };
		const needs = taskNeedsYou(withSteps, [], false, true);
		expect(needs).toMatchObject({ show: true, hasSteps: true, stepsMarkdown: steps, review: false });
		expect(taskDetailState(withSteps.status, needs, 'steps_needed')).toBe('Your steps to do');
		expect(taskDetailState(withSteps.status, needs, 'failed')).toBe('Failed');
		expect(taskDetailState(withSteps.status, taskNeedsYou(withSteps, [question], false, true), 'answer_needed')).toBe('Needs your answer');
		expect(taskNeedsYou(withSteps, [], false, false).show).toBe(false);
		expect(taskNeedsYou({ ...withSteps, report: { steps: '  \n' } }, [], false, true).show).toBe(false);
		expect(taskNeedsYou({ ...withSteps, status: 'done' }, [], false, true).show).toBe(false);
		expect(taskNeedsYou({ ...withSteps, status: 'review' }, [], false, true)).toMatchObject({ review: true, hasSteps: true });
	});

	test.each([
		['todo', 'To do'], ['in_progress', 'Working'], ['review', 'Ready for you to check'],
		['blocked', 'Blocked'], ['waiting', 'Waiting'], ['done', 'Done'], ['dropped', 'Dropped'],
	] as const)('reads %s as %s without an owner question', (status, label) => {
		const needs = taskNeedsYou(task(status), [], false, false);
		expect(needs.show).toBe(status === 'review');
		expect(taskDetailState(status, needs)).toBe(label);
	});
});

describe('structured task fields', () => {
	const report: BoardTask['report'] = { now: '', results: '- Legacy result', next: '**Legacy plan**', revision: 0, updatedAt: null, updatedBy: null };
	const hidden = { goal: undefined, hasSummary: false, hasNotDone: false, summary: undefined, notDoneMarkdown: undefined, checks: [] };
	const passed: BoardReportCheck = { name: 'Tests', result: 'passed', count: 0, at: question.askedAt };
	const failed: BoardReportCheck = { name: 'Typecheck', result: 'failed', at: question.askedAt };

	test('only exposes structured fields when supported and populated, leaving legacy prose alone', () => {
		const task = { goal: ' Reserve books. ', report: { ...report, summary: ' The form is ready. ', notDone: ' No reminders yet. \r\n\r\n* **Staff edits** are not ready.\n1. No email.', checks: [passed, failed] } };
		expect(taskDetailFields(task, false)).toEqual(hidden);
		expect(taskDetailFields({ report }, true)).toEqual(hidden);
		expect(taskDetailFields({ goal: null, report: { ...report, summary: '  ', notDone: '\n \n', checks: [] } }, true)).toEqual(hidden);
		expect(taskDetailFields(task, true)).toEqual({
			goal: 'Reserve books.', hasSummary: true, summary: 'The form is ready.',
			hasNotDone: true, notDoneMarkdown: '- No reminders yet.\n- **Staff edits** are not ready.\n- No email.', checks: [passed, failed]
		});
		expect(taskDetailFields({ goal: ' ', report: { ...report, notDone: 'Just one item.' } }, true))
			.toEqual({ ...hidden, hasNotDone: true, notDoneMarkdown: '- Just one item.' });
		expect(task.report).toMatchObject({ results: '- Legacy result', next: '**Legacy plan**' });
	});

	test('keeps agent Next separate from review instructions', () => {
		const typed = { ...report, blocks: { next: [{ kind: 'nextAction', text: 'The desk team will check again.' }] } } as const;
		expect(taskNextPlacement(report, true)).toBe('review');
		expect(taskNextPlacement(report, false)).toBe('next');
		expect(taskNextPlacement({ ...report, next: '' }, true)).toBeUndefined();
		expect(taskNextPlacement({ ...typed, blocks: { next: [...typed.blocks.next] } }, true)).toBe('next');
		expect(taskNextPlacement({ ...report, blocks: { next: [{ kind: 'future' }] } } as unknown as BoardTask['report'], true)).toBe('next');
	});

	test('names failed checks without listing passing checks', () => {
		expect(failedCheckLine([])).toBeUndefined();
		expect(failedCheckLine([passed])).toBeUndefined();
		expect(failedCheckLine([passed, failed])).toBe('One check failed: Typecheck');
		expect(failedCheckLine([failed, passed, { ...failed, name: 'Build' }])).toBe('2 checks failed: Typecheck, Build');
	});

	test('uses structured choices or falls back to the original options, and warnings have neither', () => {
		const choices = [{ label: 'Now', effect: 'Books go on sale today.', recommended: true }, { label: 'Later' }];
		const options = ['Now', 'Later'];
		const legacy = { ...question, options };
		const withChoices = { ...legacy, choices };
		expect(questionAnswers(withChoices, true)).toEqual({ kind: 'choices', choices });
		for (const answers of [questionAnswers(withChoices, false), questionAnswers(legacy, true), questionAnswers({ ...legacy, choices: [] }, true)]) {
			expect(answers).toEqual({ kind: 'options', options });
		}
		expect(questionAnswers({ ...withChoices, kind: 'warning' }, true)).toEqual({ kind: 'options', options: [] });
	});
});

test('Files shows the full task feed without a disclosure after What you get', async () => {
	const sheet = await Bun.file(new URL('../src/lib/components/task-view/ClassicTaskView.svelte', import.meta.url)).text();
	const sections = sheet.slice(sheet.indexOf('aria-label="What you get"'), sheet.indexOf('aria-label="The record"'));
	expect(sections).toMatch(/<section[^>]+aria-label="Files">\s*<h2[^>]*>Files[^<]*<\/h2>\s*<TaskFiles \{artifacts\}[^>]+onupdatetags=/);
	const model = await Bun.file(new URL('../src/lib/task-view/model.svelte.ts', import.meta.url)).text();
	expect(model).toContain('filter: { taskId } }');
	expect(sheet.slice(sheet.indexOf('<aside class="task-about"'))).not.toContain('<TaskFiles');
});

describe('record folds', () => {
	test('the request is the first record row and the only one open without a saved choice', async () => {
		const sheet = await Bun.file(new URL('../src/lib/components/task-view/ClassicTaskView.svelte', import.meta.url)).text();
		const record = sheet.slice(sheet.indexOf('<section aria-label="The record">'), sheet.indexOf('<aside class="task-about"'));
		expect(Array.from(record.matchAll(/<TaskRecordFold row="(\w+)"/g), match => match[1])).toEqual(['request', 'checks', 'decided', 'activity']);
		const emptyStorage = { getItem: () => null, setItem: () => {} };
		expect(readTaskRecordFold('request', emptyStorage)).toBe(true);
		expect(readTaskRecordFold('checks', emptyStorage)).toBe(false);
		expect(readTaskRecordFold('decided', emptyStorage)).toBe(false);
		expect(readTaskRecordFold('activity', emptyStorage)).toBe(false);
	});

	test('each row remembers its own choice', () => {
		const saved = new Map<string, string>();
		const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
		saveTaskRecordFold('request', false, storage);
		saveTaskRecordFold('activity', true, storage);
		saveTaskRecordFold('checks', true, storage);
		expect(readTaskRecordFold('request', storage)).toBe(false);
		expect(readTaskRecordFold('checks', storage)).toBe(true);
		expect(readTaskRecordFold('activity', storage)).toBe(true);
		expect(readTaskRecordFold('decided', storage)).toBe(false);
	});

	test('bad or unavailable storage uses the defaults', () => {
		const corrupt = { getItem: () => 'true', setItem: () => {} };
		const unavailable = { getItem: () => { throw new Error(); }, setItem: () => { throw new Error(); } };
		expect(readTaskRecordFold('request', corrupt)).toBe(true);
		expect(readTaskRecordFold('activity', unavailable)).toBe(false);
		expect(() => saveTaskRecordFold('activity', true, unavailable)).not.toThrow();
	});
});

describe('Done when', () => {
	test('makes a list out of separated criteria, not a single sentence', () => {
		expect(acceptanceMarkdown('Reserve a book; get an email;')).toBe('- Reserve a book\n- get an email');
		expect(acceptanceMarkdown('Reserve a book\r\nGet an email')).toBe('- Reserve a book\n- Get an email');
		expect(acceptanceMarkdown('Reserve a book.')).toBe('Reserve a book.');
	});

	test('keeps existing lists, blank-line paragraphs and inline code/links', () => {
		const list = '1. Reserve a book; check stock\n2. Get an email';
		expect(acceptanceMarkdown(list)).toBe(list);
		expect(acceptanceMarkdown('First paragraph.\n\nSecond paragraph.')).toBe('First paragraph.\n\nSecond paragraph.');
		expect(acceptanceMarkdown('Show `a;b`; visit [a;b](https://example.com/a;b); finish'))
			.toBe('- Show `a;b`\n- visit [a;b](https://example.com/a;b)\n- finish');
	});
});
