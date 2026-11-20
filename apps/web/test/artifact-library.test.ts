import { describe, expect, it } from 'bun:test';
import type { Artifact, ArtifactTaskFacts, Board } from '@kemiri/protocol';
import { artifactHistory, fallbackLibrary, filterLibrary, libraryPairs, libraryShelves, mergeLibraries, objectShape, taskDoneSplit } from '../src/lib/artifact-library.ts';

const at = (day: number) => new Date(2026, 10, day, 12).toISOString();
const project = { id: 'bakery', name: 'Juniper Bakery', archived: false };
const otherProject = { id: 'market', name: 'Market notes', archived: true };
const task: ArtifactTaskFacts = { id: 'T1', projectId: project.id, title: 'Publish the autumn menu', status: 'done', settledAt: at(5), archived: true };
function artifact(id: string, overrides: Partial<Artifact> = {}): Artifact {
	return { id, projectId: project.id, name: `${id}.png`, title: null, note: null, kind: 'image', mimeType: 'image/png', size: 10, durationSeconds: null,
		threadId: 'main', workerId: null, taskId: task.id, sourcePath: `/tmp/${id}.png`, createdAt: at(20), ...overrides };
}
const entries = (...artifacts: Artifact[]) => mergeLibraries([['local', { projects: [project, otherProject], tasks: [task], artifacts }]]);

describe('artifact library', () => {
	it('keeps task and artifact IDs distinct across projects and backends, including archived work', () => {
		const rows = mergeLibraries([
			['local', { projects: [project, otherProject], tasks: [task, { ...task, title: 'Choose a supplier', projectId: otherProject.id }], artifacts: [artifact('same'), artifact('same', { projectId: otherProject.id }), artifact('same')] }],
			['remote', { projects: [project], tasks: [{ ...task, title: 'Another bakery' }], artifacts: [artifact('same', { createdAt: at(21) })] }],
		]);
		expect(rows.map(row => row.task?.title)).toEqual(['Another bakery', 'Publish the autumn menu', 'Choose a supplier']);
		expect(libraryShelves(rows, 'task')).toHaveLength(3);
	});

	it('uses board facts on fallback without requiring an accessible board', () => {
		const board = { tasks: [{ ...task, report: { summary: 'The menu is printed.' } }], decisions: [{ taskId: task.id, id: 'D1', text: 'Use paper', why: null, at: at(4) }] } as Board;
		const rows = [artifact('menu')];
		expect(fallbackLibrary(project, rows).artifacts).toEqual(rows);
		expect(fallbackLibrary(project, rows).tasks).toEqual([]);
		expect(fallbackLibrary(project, rows, board).tasks).toMatchObject([{ ...task, summary: 'The menu is printed.', decisions: [{ id: 'D1' }] }]);
	});

	it('groups task shelves newest first and gives each chat its own shelf', () => {
		const rows = entries(artifact('old', { createdAt: at(1) }), artifact('chat-a', { taskId: null, createdAt: at(18) }), artifact('chat-b', { taskId: null, threadId: 'notes', createdAt: at(17) }), artifact('new'));
		const shelves = libraryShelves(rows, 'task');
		expect(shelves.map(shelf => shelf.entries.map(row => row.artifact.id))).toEqual([['new', 'old'], ['chat-a'], ['chat-b']]);
		expect(shelves[0]?.task?.status).toBe('done');
	});

	it('groups kind, calendar periods, and living rows', () => {
		const rows = entries(artifact('old', { createdAt: at(0) }), artifact('middle', { createdAt: at(5), name: 'sales.md', kind: 'text' }), artifact('new', { living: { since: at(19) } }));
		expect(libraryShelves(rows, 'kind').map(shelf => shelf.title)).toEqual(['Images', 'Pages']);
		expect(libraryShelves(rows, 'time', new Date(at(20))).map(shelf => shelf.title)).toEqual(['This week', 'Earlier this month', 'October 2026']);
		expect(libraryShelves(rows, 'living').flatMap(shelf => shelf.entries.map(entry => entry.artifact.id))).toEqual(['new']);
	});

	it('filters against the file, title, task, kind and tags', () => {
		const rows = entries(artifact('checkout', { title: 'Front counter', tags: ['web', 'phone'] }), artifact('other'));
		expect(filterLibrary(rows, rows[0]!.project.key, ['web'], 'front checkout autumn image phone').map(row => row.artifact.id)).toEqual(['checkout']);
	});

	it('draws objects from kind and tags', () => {
		expect([
			artifact('phone', { tags: ['web', 'android'] }), artifact('screen', { tags: ['desktop'] }), artifact('clip', { kind: 'video' }),
			artifact('report', { kind: 'text', name: 'report.html' }), artifact('note', { kind: 'text', name: 'note.md' }),
			artifact('log', { kind: 'text', name: 'run.log' }), artifact('pdf', { kind: 'file' }),
		].map(objectShape)).toEqual(['phone', 'screen', 'recording', 'paper', 'paper', 'slip', 'file']);
	});

	it('matches pairs by exact tag sets and never across task or project boundaries', () => {
		const rows = entries(artifact('before', { tags: ['phone', 'before', 'web'], createdAt: at(18) }), artifact('after', { tags: ['after', 'web', 'phone'] }),
			artifact('dark', { tags: ['after', 'web', 'phone', 'dark'] }), artifact('other-task', { taskId: 'T2', tags: ['before', 'web', 'phone'] }),
			artifact('other-project', { projectId: otherProject.id, tags: ['after', 'web', 'phone'] }));
		expect(libraryPairs(rows).map(pair => [pair.before.artifact.id, pair.after.artifact.id])).toEqual([['before', 'after']]);
	});

	it('marks the split and groups consecutive saves without crossing comments, completion, or later tasks', () => {
		const versions = [artifact('v1', { version: 1, createdAt: at(3) }), artifact('v2', { version: 2, createdAt: at(5) }),
			artifact('v3', { version: 3, createdAt: at(7) }), artifact('v4', { version: 4, createdAt: at(9), madeForTaskId: 'T2' })];
		expect(taskDoneSplit(versions, at(5))).toBe(2);
		expect(taskDoneSplit(versions, at(1))).toBe(-1);
		expect(taskDoneSplit(versions, at(10))).toBe(-1);
		const history = artifactHistory(versions, [{ taskId: 'T1', feedbackId: 'F1', version: 3, text: 'Show the order total', at: at(8), state: 'addressed', note: 'Added.' }], at(5), at(6));
		expect(history.map(event => event.kind)).toEqual(['save', 'done', 'living', 'save', 'comment', 'save']);
		expect(history[0]).toMatchObject({ first: { version: 1 }, last: { version: 2 } });
	});
});
