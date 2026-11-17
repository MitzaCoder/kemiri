import { makeGraphFixture, FIXTURE_NOW } from '../../web/test/fixtures/task-graph-busy.ts';
import { buildGraphModel, graphSummaryCounters, searchGraph } from '../../web/src/lib/task-graph-model.ts';
import { graphHoldsUp } from '../../web/src/lib/task-graph-changes.ts';
import { buildTaskGraph } from '../../web/src/lib/task-graph.ts';
import { graphFoldGroups, graphFoldExpansion } from '../../web/src/lib/task-graph-live.ts';
import type { BoardTask, BoardQuestion, WorkerSummary } from '@kemiri/protocol';

// The web model is the executable oracle. JVM tests consume the same synthetic input and expected results.
const fixture = makeGraphFixture(18);
const tasks = fixture.board.tasks;
tasks[0] = { ...tasks[0]!, archived: true };
tasks[4] = { ...tasks[4]!, status: 'dropped' };
tasks[12] = { ...tasks[12]!, parent: 'T14', blockedBy: ['T2', 'T4'] };
tasks[13] = { ...tasks[13]!, parent: 'T13', blockedBy: ['T2', 'T13'] };
tasks[14] = { ...tasks[14]!, parent: 'T13', blockedBy: ['T14'] };
fixture.workers[0] = { ...fixture.workers[0]!, status: 'failed', lastReport: 'Checked reconnect safety.', failure: 'Synthetic interrupted check' };
const model = buildGraphModel(tasks, fixture.board.questions, fixture.workers, fixture.threads, Date.parse(FIXTURE_NOW));
const queries = ['T2', 'access', 'fern', 'Sync crew', 'reconnect', 'absent'];
// Compact fold inputs keep the cross-platform oracle readable rather than duplicating full DTO fixtures.
const foldCases: { name: string; tasks: (Pick<BoardTask, 'id'> & Partial<BoardTask>)[];
	workers?: Pick<WorkerSummary, 'id' | 'taskId' | 'status'>[];
	questions?: (Pick<BoardQuestion, 'id' | 'taskId'> & Partial<BoardQuestion>)[] }[] = [
	{ name: 'derived kinds', tasks: ['failed', 'answer_needed', 'review', 'working', 'clarifying', 'paused', 'blocked_by_task', 'todo', 'waiting_outside', 'done', 'dropped'].map((kind, i) => ({
		id: `T${i + 1}`, state: { kind: kind as NonNullable<BoardTask['state']>['kind'], group: ['failed', 'answer_needed', 'review'].includes(kind) ? 'needs_you' : kind === 'todo' ? 'todo' : 'waiting', refs: [], since: FIXTURE_NOW },
	})) },
	{ name: 'legacy attention', tasks: [{ id: 'T1' }, { id: 'T2', status: 'waiting' }, { id: 'T3', status: 'review' }, { id: 'T4', status: 'blocked' }, { id: 'T5', status: 'in_progress' }, { id: 'T6' }],
		questions: [{ id: 'Q1', taskId: 'T1' }, { id: 'Q2', taskId: 'T6', waitingOn: 'agent' }] },
	{ name: 'quiet families and hidden parts', tasks: [{ id: 'T1' }, { id: 'T2', parent: 'T1' }, { id: 'T3', subtaskCount: { done: 1, total: 1 } }, { id: 'T4' }] },
	{ name: 'recursive prerequisites not neighbours', tasks: [{ id: 'T1', status: 'in_progress', blockedBy: ['T2'] }, { id: 'T2', blockedBy: ['T3'] }, { id: 'T3' }, { id: 'T4', blockedBy: ['T1'] }, { id: 'T5', related: ['T2'], foundWhile: 'T1' }] },
	{ name: 'group dependency cycle', tasks: [{ id: 'T1', blockedBy: ['T2'] }, { id: 'T2', status: 'waiting', blockedBy: ['T1'] }] },
	{ name: 'busy crew and resting', tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }], workers: [{ id: 'busy', taskId: 'T1', status: 'running' }, { id: 'idle', taskId: 'T2', status: 'idle' }, { id: 'failed', taskId: 'T3', status: 'failed' }] },
];
const folding = foldCases.map(input => {
	const workers = input.workers ?? [], questions = input.questions ?? [];
	const graph = buildTaskGraph(input.tasks.map(task => ({ ...tasks[1]!, status: 'todo', state: undefined, archived: false, parent: null, subtaskCount: undefined, workerIds: [], blockedBy: [], related: [], foundWhile: null, ...task })),
		questions.map(question => ({ ...fixture.board.questions[0]!, status: 'open', kind: 'question', ...question })),
		workers.map(worker => ({ ...fixture.workers[0]!, ...worker })), []);
	const groups = graphFoldGroups(graph, questions.map(question => ({ ...fixture.board.questions[0]!, status: 'open', ...question })));
	return { ...input, workers, questions, groups, expandedTodo: [...graphFoldExpansion(graph, groups, new Set(['todo']))].sort() };
});
const vector = {
	folding,
	now: FIXTURE_NOW, tasks, questions: fixture.board.questions, workers: fixture.workers, threads: fixture.threads,
	details: [...model.details.values()].map(d => ({
		id: d.task.id, familyId: d.familyId, progress: d.progress, reasons: d.reasons, quiet: d.quiet,
		children: d.children, blocks: d.blocks, workers: d.workers.map(w => w.id), threads: d.threads.map(t => t.id),
		holdsUp: graphHoldsUp(tasks, d.task.id),
	})),
	counters: graphSummaryCounters(model).map(c => ({ key: c.key, count: c.count })),
	search: queries.map(query => ({ query, results: searchGraph(model, query) })),
};
const path = new URL('../test-vectors/task-graph-v1.json', import.meta.url);
const source = JSON.stringify(vector, null, 2) + '\n';
if (Bun.argv.includes('--check')) {
	if (await Bun.file(path).text() !== source) throw new Error('Graph vectors differ from the web model');
	console.log('Graph vectors match the web model');
} else await Bun.write(path, source);
