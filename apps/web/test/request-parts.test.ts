import { expect, test } from 'bun:test';
import { createServer } from 'vite';
import type { BoardQuestion, BoardTask, BoardTaskInput, BoardTaskState, PartsDigest } from '@kemiri/protocol';
import { kanbanColumns, needsYouCount } from '../src/lib/kanban.js';
import { partsChecklist, requestAttentionLink, requestPartPage, taskCanClose } from '../src/lib/request-parts.js';
import { saveWithCloseChoice } from '../src/lib/task-close.js';
import { taskNeedsYou } from '../src/lib/task-details.js';
import { taskFamilies, taskFamilyCount, taskFamilySections } from '../src/lib/task-families.js';
import { taskSections, type TaskRow } from '../src/lib/tasks.js';

const at = '2026-01-08T14:02:00Z';
const state = (kind: BoardTaskState['kind'], group: BoardTaskState['group'], refs: string[] = []): BoardTaskState => ({ kind, group, since: at, refs });
function task(id: string, overrides: Partial<BoardTask> = {}): BoardTask {
	return {
		id, title: `Example ${id}`, revision: 1, description: '', acceptance: null, status: 'todo', blockedBy: [], blockedReason: null,
		writeScopes: [], workerIds: [], scheduleId: null, report: { now: '', results: '', next: '', revision: 0, updatedAt: null, updatedBy: null },
		snapshots: 0, order: Number(id.slice(1)), createdBy: 'user', updatedBy: 'user', createdAt: at, updatedAt: at, settledAt: null, archived: false,
		...overrides,
	};
}

const question: BoardQuestion = { id: 'Q2', revision: 1, taskId: 'T2', text: 'Paper boxes or tins?', status: 'open', answer: null, kind: 'question', options: [], askedAt: at, answeredAt: null };
const request = task('T1', { state: { ...state('answer_needed', 'needs_you', ['Q2']), fromPartId: 'T2', fromPartTitle: 'Choose the sample boxes' } });
const askingPart = task('T2', { parent: 'T1', requestId: 'T1', state: state('answer_needed', 'needs_you', ['Q2']) });
const closedPart = task('T3', { parent: 'T1', requestId: 'T1', status: 'done', state: state('done', 'closed'), settledAt: at });

function byPart(rows: TaskRow[], requestId: string) {
	return new Map([[requestId, rows.filter(row => row.task.requestId === requestId)]]);
}
const href = (id: string) => `/project?task=${id}`;

test('Needs you counts the request once and links to the originating question or steps', () => {
	const sections = taskSections({ tasks: [request, askingPart, closedPart], questions: [question] });
	const [section] = taskFamilySections(sections, true);
	expect(taskFamilyCount(section!, true)).toBe(1);
	const [family] = taskFamilies(section!, { T1: true }, byPart(sections.flatMap(group => group.rows), request.id));
	expect(family).toMatchObject({ row: { task: request }, children: [], canToggle: false, role: 'task' });
	expect(requestAttentionLink(request, [question], href)).toEqual({ taskId: 'T2', href: '/project?task=T2#task-question-Q2', text: 'Paper boxes or tins?', partTitle: 'Choose the sample boxes' });
	expect(requestAttentionLink({ ...request, state: { ...request.state!, kind: 'steps_needed', refs: [] } }, [], href)?.href).toBe('/project?task=T2#task-steps');
	expect(requestAttentionLink({ ...request, state: { ...request.state!, kind: 'failed', refs: [] } }, [], href)?.href).toBe('/project?task=T2#task-needs-you');
});

test('unfolding a request puts running and attention parts before quiet parts, and counts done together', () => {
	const workingRequest = { ...request, state: state('working', 'in_progress') };
	const tasks = [workingRequest, task('T4', { parent: 'T1', requestId: 'T1', state: state('todo', 'todo'), order: 0 }), askingPart, closedPart,
		task('T5', { parent: 'T1', requestId: 'T1', state: state('working', 'in_progress') }), task('T6', { status: 'done', state: state('done', 'closed') })];
	const sections = taskSections({ tasks, questions: [] });
	const [active, closed] = taskFamilySections(sections, true);
	const parts = byPart(sections.flatMap(group => group.rows), request.id);
	expect(taskFamilies(active!, {}, parts)[0]).toMatchObject({ canToggle: true, expanded: false, children: [] });
	const [expanded] = taskFamilies(active!, { T1: true }, parts);
	expect(expanded?.children.map(child => child.row.task.id)).toEqual(['T2', 'T5', 'T4']);
	expect(expanded?.doneParts).toBe(1);
	expect(closed?.rows.map(row => row.task.id)).toEqual(['T6']);
	const cards = kanbanColumns({ tasks, questions: [] }, { requestAttention: true, stateEnabled: true }).flatMap(column => column.cards);
	expect(cards.map(card => card.task.id).sort()).toEqual(['T1', 'T6']);
	expect(needsYouCount({ tasks: [request, askingPart], questions: [question] }, true)).toBe(1);
});

const digest: PartsDigest = {
	parts: Array.from({ length: 7 }, (_, index) => ({ id: `T${index + 2}`, parentId: 'T1', title: `Part ${index + 1}`, state: index < 5 ? 'done' : 'working', summary: `**Result ${index + 1}**\nSecond line`, checks: { total: 2, passed: 2, failed: 0 }, notDoneCount: 0, closedAt: index < 5 ? at : undefined, closedBy: index < 5 ? index === 1 ? 'coordinator' : 'user' : undefined })),
	done: 5, total: 7, working: 2, needsOwner: 0,
};
const partProof = [{ partId: 'T3', images: 2, videos: 1, html: 0, files: 0 }];

test('the real checklist renders digest order, checks, proof counts and more parts', async () => {
	const vite = await createServer({ root: import.meta.dir + '/..', server: { middlewareMode: true, ws: false }, logLevel: 'error' });
	try {
		const { default: PartsChecklist } = await vite.ssrLoadModule('/src/lib/components/task-view/PartsChecklist.svelte');
		const { render } = await vite.ssrLoadModule('svelte/server');
		const html: string = render(PartsChecklist, { props: { digest, partProof, taskHref: href } }).body;
		expect(html).toContain('5 of 7 done');
		expect(html).toContain('2 images · 1 video');
		expect(html).toContain('2 checks');
		expect(html).toContain('…2 more parts');
		expect(html.indexOf('href="/project?task=T6"')).toBeLessThan(html.indexOf('<details'));
		expect(html.indexOf('href="/project?task=T7"')).toBeGreaterThan(html.indexOf('<details'));
		expect(partsChecklist(digest, partProof)[0]?.summary).toBe('Result 1');
	} finally { await vite.close(); }
}, 20000);

test('the part page names who closed it and never renders the review close control', async () => {
	const root = { ...request, partsDigest: digest };
	const checkedPage = requestPartPage(closedPart, root, true);
	expect(checkedPage).toEqual({ requestId: 'T1', requestTitle: root.title, position: 'Part 2 of 7', closure: 'Checked by the coordinator', closedAt: at });
	const vite = await createServer({ root: import.meta.dir + '/..', server: { middlewareMode: true, ws: false }, logLevel: 'error' });
	const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem() {}, removeItem() {} } });
	try {
		const { default: RequestPartView } = await vite.ssrLoadModule('/test/fixtures/RequestPartView.svelte');
		const { render } = await vite.ssrLoadModule('svelte/server');
		function renderSheet(shown: BoardTask, negotiated: boolean): string {
			const partPage = requestPartPage(shown, root, negotiated);
			return render(RequestPartView, { props: { model: {
				task: shown, partPage, canClose: taskCanClose(partPage), needsYou: taskNeedsYou(shown, [], false, true),
				backend: { id: 'demo', ready: true, supports: () => false }, projectId: 'demo', derivedNotDone: [],
				decided: [], taskWorkers: [], artifacts: [], tasks: [root, shown], blockers: [], taskHref: href,
				supportsLinks: false, ago: () => 'Just now', registerQuoteScope: () => undefined,
			} } }).body;
		}
		const checked = renderSheet(closedPart, true);
		expect(checked).toContain('Part 2 of 7');
		expect(checked).toContain('Checked by the coordinator · ');
		expect(checked).toContain('Reopen with a note…');
		expect(checked).toContain('Comment');
		expect(checked).not.toContain('Change task status');
		expect(renderSheet({ ...closedPart, id: 'T2' }, true)).toContain('Closed by you');
		const legacyReview = { ...askingPart, status: 'review' as const };
		expect(renderSheet(legacyReview, true)).not.toContain('It works: close the task');
		expect(renderSheet(legacyReview, false)).toContain('It works: close the task');
	} finally {
		if (storage) Object.defineProperty(globalThis, 'localStorage', storage);
		else Reflect.deleteProperty(globalThis, 'localStorage');
		await vite.close();
	}
}, 20000);

test('close confirmation names only unfinished parts and skips entirely when all are checked or dropped', async () => {
	const input = { ...request, status: 'done' } satisfies BoardTaskInput;
	const asked: string[] = [];
	const savedChoices: (string | undefined)[] = [];
	let tasks = [closedPart, { ...closedPart, id: 'T4', status: 'dropped' as const }];
	const context = {
		enabled: true, tasks: () => tasks, refresh: async () => {},
		ask: async (message: string) => { asked.push(message); return 'follow_up' as const; },
		save: async (_input: BoardTaskInput, options: { openParts?: string }) => { savedChoices.push(options.openParts); return request; },
	};
	await saveWithCloseChoice(input, { taskId: 'T1' }, context);
	expect(asked).toEqual([]);
	tasks = [...tasks, { ...askingPart, status: 'in_progress' }];
	await saveWithCloseChoice(input, { taskId: 'T1' }, context);
	expect(asked).toEqual(['T1 has 1 open part: T2 (in progress). What should happen to them?']);
	expect(savedChoices).toEqual([undefined, 'follow_up']);
});

test('without request features the legacy attention rows, board cards and part actions stay', () => {
	const root = { ...request, state: state('working', 'in_progress') };
	const sections = taskFamilySections(taskSections({ tasks: [root, askingPart, closedPart], questions: [question] }));
	const families = taskFamilies(sections[0]!, {});
	expect(families[0]?.role).toBe('parentHeader');
	expect(families[0]?.children[0]?.row.task.id).toBe('T2');
	expect(kanbanColumns({ tasks: [root, askingPart], questions: [question] }, { stateEnabled: true }).flatMap(column => column.cards.map(card => card.task.id))).toContain('T2');
	expect(taskCanClose(requestPartPage(closedPart, root, false))).toBe(true);
});
