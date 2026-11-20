import { describe, expect, it } from 'bun:test';
import type { BoardTask } from '@kemiri/protocol';
import { attachDiscussion, discussHeader, discussionReference, discussionText, newestDiscussionFollowUp, settledDiscussionTask } from '../src/lib/artifact-discuss.ts';
import { appendReviewDraft } from '../src/lib/artifact-review-draft.ts';

const header = 'Discuss "Seasonal guide"\n(artifact artifact-abc~4, guide.html)';

describe('Discuss an artifact', () => {
	it('pins the exact plain-text message the coordinator and artifact trail read', () => {
		const reference = discussHeader({ id: 'artifact-abc~4', version: 4, title: 'Seasonal guide', name: 'guide.html' });
		const wire = discussionText(reference, 'Move the meeting point to the top.');
		expect(wire).toBe(`${header}\n\nMove the meeting point to the top.`);
		expect(discussionReference(wire)).toEqual({ title: 'Seasonal guide', artifactId: 'artifact-abc', version: 4, name: 'guide.html', header, body: 'Move the meeting point to the top.' });
		expect(discussionReference('Discuss a guide without a reference')).toBeUndefined();
	});

	it('pins version one on legacy artifacts and breaks no header lines', () => {
		expect(discussHeader({ id: 'legacy', title: 'A "guide"\nfor plants', name: 'plants.html' })).toBe('Discuss "A ′guide′ for plants"\n(artifact legacy~1, plants.html)');
	});

	it('uses the existing draft append path, preserving words and replacing only the chip and task', () => {
		const existing = { text: 'Keep my words', quotes: ['Keep this quote'], taskId: 'T2' };
		const attached = appendReviewDraft(existing, header, 'T4', true);
		expect(attached).toEqual({ ...existing, text: `${header}\n\nKeep my words`, taskId: 'T4' });
		expect(attachDiscussion(attached, header)).toEqual({ text: attached.text, quotes: existing.quotes });
	});

	it('selects only the newest coordinator follow-up after the Discuss message', () => {
		const sent = Date.parse('2026-11-10T12:00:00Z');
		const task = (id: string, delta: number, changes: Partial<BoardTask> = {}) => ({ id, foundWhile: 'T1', createdBy: 'coordinator', createdAt: new Date(sent + delta).toISOString(), status: 'todo', ...changes } as BoardTask);
		const dropped = task('T12', 200, { status: 'dropped' });
		const tasks = [task('T2', -10), task('T3', 0), task('T4', 100), task('T10', 200), dropped,
			task('T13', 300, { createdBy: 'user' }), task('T14', 400, { foundWhile: 'T2' })];
		expect(newestDiscussionFollowUp(tasks, 'T1', sent)).toBe(dropped);
		expect(settledDiscussionTask(dropped)).toBe(true);
		expect(settledDiscussionTask(task('T2', 0))).toBe(false);
	});
});
