import { describe, expect, test } from 'bun:test';
import type { BoardQuestion, BoardTask, ThreadSummary } from '@kemiri/protocol';
import { coordinatorBadges, coordinatorOfThread, coordinatorRoster, coordinatorShortcut, externalParts, projectEntryHref, scopedQuestions, scopedTasks } from '../src/lib/coordinators.js';

const thread = (id: string, fields: Partial<ThreadSummary> = {}) => ({ id, title: id, main: id === 'main', status: 'idle', openQuestions: 0, runningWorkers: 0, kind: 'coordinator', ...fields }) as ThreadSummary;
const general = thread('main', { title: 'General', order: 8 });
const shop = thread('shop', { order: 2 });
const kitchen = thread('kitchen', { order: 1 });
const job = thread('audit', { kind: 'job', parentThreadId: 'shop' });
const task = (id: string, coordinatorId?: string, parent?: string) => ({ id, coordinatorId, parent, archived: false }) as BoardTask;

describe('coordinator presentation', () => {
	test('keeps General first, preserves owner order and leaves jobs and archives out', () => {
		const rows = [shop, job, kitchen, thread('archive', { archived: true }), general];
		expect(coordinatorRoster(rows).map(row => row.id)).toEqual(['main', 'kitchen', 'shop']);
		expect(coordinatorRoster(rows, false)).toEqual([]);
		expect(coordinatorOfThread(job.id, rows)).toBe('shop');
		expect(coordinatorOfThread('legacy-job', rows)).toBe('main');
	});

	test('separates explicit pause, work, unread and needs attention', () => {
		const now = '2026-01-01T02:00:00.000Z';
		const row = thread('shop', { held: true, runningWorkers: 1, lastReplyAt: now, attention: { questions: 1, steps: 2, review: 1, failed: 0, warnings: 1 } });
		expect(coordinatorBadges(row)).toMatchObject({ needsYou: 5, paused: true, working: true, unread: true });
		expect(coordinatorBadges(row, now).unread).toBe(false);
		expect(coordinatorBadges(thread('idle')).state).toBe('Idle');
		expect(coordinatorBadges(thread('held', { held: true })).state).toBe('Paused');
		expect(coordinatorBadges(thread('failed', { status: 'failed' })).state).toBe('Failed');
	});

	test('scopes by derived ownership, leaving external parts available as pointers', () => {
		const parent = task('T1', 'shop');
		const part = task('T2', 'kitchen', parent.id);
		const sameOwner = task('T3', 'shop', parent.id);
		const tasks = [parent, part, sameOwner, task('T4'), { ...part, id: 'T5', archived: true }];
		const scoped = scopedTasks(tasks, 'shop');
		expect(scoped.map(row => row.id)).toEqual(['T1', 'T3']);
		expect(externalParts(parent, tasks, new Set(scoped.map(row => row.id)))).toEqual([part]);
		expect(scopedTasks(tasks, undefined, new Set(['shop'])).map(row => row.id)).toEqual(['T2', 'T4', 'T5']);
		expect(scopedTasks(tasks, 'main').map(row => row.id)).toEqual(['T4']);
	});

	test('scopes a job question to its coordinator', () => {
		const questions = [{ id: 'Q1', threadId: job.id }, { id: 'Q2' }, { id: 'Q3', threadId: kitchen.id }] as BoardQuestion[];
		expect(scopedQuestions(questions, [general, kitchen, shop, job], 'shop').map(row => row.id)).toEqual(['Q1']);
		expect(scopedQuestions(questions, [], 'main')).toEqual(questions);
	});

	test('restores only project entry links; General and legacy links use the project URL', () => {
		expect(projectEntryHref('b', 'p', true, () => null)).toBe('/b/b/projects/p');
		expect(projectEntryHref('b', 'p', true, () => shop.id)).toBe('/b/b/projects/p/threads/shop');
		expect(projectEntryHref('b', 'p', true, () => 'main')).toBe('/b/b/projects/p');
		expect(projectEntryHref('b', 'p', false, () => { throw Error('Legacy does not use the preference'); })).toBe('/b/b/projects/p');
	});

	test('handles Alt+1 through Alt+9 without hijacking plain numbers or other chords', () => {
		const event = { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, code: 'Digit1' };
		expect(coordinatorShortcut(event)).toBe(0);
		expect(coordinatorShortcut({ ...event, code: 'Digit9' })).toBe(8);
		for (const other of [{ altKey: false }, { ctrlKey: true }, { code: 'Digit0' }, { repeat: true }, { code: 'KeyJ' }]) {
			expect(coordinatorShortcut({ ...event, ...other })).toBeUndefined();
		}
	});
});
