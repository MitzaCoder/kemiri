import { beforeAll, expect, test } from 'bun:test';
import type { BoardFeedback } from '@kemiri/protocol';
import { loadSvelteSsr } from './svelte-ssr.js';

let ssr: typeof import('./fixtures/task-feedback-ssr.js');
beforeAll(async () => {
	ssr = await loadSvelteSsr(`${import.meta.dir}/fixtures/task-feedback-ssr.ts`) as typeof ssr;
});

function renderNotes(loading: boolean, entries: BoardFeedback[] = [], problem?: string) {
	return ssr.render(ssr.TaskFeedback, {
		props: { loading, entries, problem, busy: false, onset() {}, threadName: () => 'Kitchen API' },
	}).body;
}

test('an empty note list stops loading when the timeline read finishes', () => {
	expect(renderNotes(true)).toContain('Loading notes…');
	const empty = renderNotes(false);
	expect(empty).not.toContain('Loading notes…');
	expect(empty).toContain('No notes to show.');
});

test('stored notes and read errors are not replaced by an empty message', () => {
	const actual = renderNotes(false, [{
		id: 'F1', state: 'open', text: '', images: 1, note: null,
		at: '2026-01-01T12:00:00Z', threadId: 'main', changes: [],
	}]);
	expect(actual).toContain('1 image');
	expect(actual).toContain('Dismiss note');
	expect(actual).not.toContain('No notes to show.');
	const error = renderNotes(false, [], 'Could not load the task timeline.');
	expect(error).toContain('role="alert"');
	expect(error).not.toContain('No notes to show.');
});
