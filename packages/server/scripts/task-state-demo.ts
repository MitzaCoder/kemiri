/** Synthetic task-state proof backend. Bun only; all data/config live in createSetup's temporary root. */
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { createSetup, TestClient, ViewClient } from '../test/support.ts';
import { BoardDoc, saveTask } from '../src/board.ts';
import { activityTracking } from '../src/task-activity.ts';
import type { BoardTaskInput } from '@kemiri/protocol';

const origins = (process.env.DEMO_ORIGINS ?? 'http://localhost:5210,http://localhost:5211').split(',');
const output = process.env.DEMO_OUTPUT ?? '/tmp/task-state-demo.json';
let clock = Date.now() - 3 * 3600000;
const setup = await createSetup({ allowedOrigins: origins, terminals: false, now: () => clock });
setup.faux.setResponses(Array.from({ length: 30 }, () => async (_request: unknown, options?: { signal?: AbortSignal }) => {
	await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
	return fauxAssistantMessage('Synthetic session ended.');
}));
const requestParts = process.env.DEMO_REQUEST_PARTS === '1';
const git = (...args: string[]) => {
	const result = Bun.spawnSync(['git', '-c', 'user.name=Bakery Demo', '-c', 'user.email=demo@example.test', ...args], { cwd: setup.projectDir });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
};
if (requestParts) git('init', '-b', 'main');
const client = await TestClient.open(setup.server); await client.hello();
const added = await client.request({ type: 'projects.add', path: setup.projectDir });
if (added.type !== 'projects.add') throw new Error('Could not add synthetic project');
const projectId = added.project.id;
await client.request({ type: 'projects.configure', projectId, name: 'Little bakery', coordinatorModel: { provider: 'faux', modelId: 'faux-1' }, workerModels: [{ provider: 'faux', modelId: 'faux-1' }] });
const view = new ViewClient(client); await view.start(projectId);
const { runtime } = await setup.server.manager.open(projectId);
const needsYouFamilies = process.env.DEMO_NEEDS_YOU_FAMILIES === '1';
const familyTasks: [title: string, status: BoardTaskInput['status'], parent?: string][] = [
	['Publish the spring menu', 'in_progress'],
	['Write the menu text', 'review', 'T1'],
	['Photograph the pastries', 'review', 'T1'],
	['Prepare the market stall', 'in_progress'],
	['Order a second awning', 'review', 'T4'],
	['Print the price cards', 'review', 'T4'],
	['Pack the sample boxes', 'in_progress', 'T4'],
	['Repair the big oven', 'in_progress'],
	['Approve the repair quote', 'in_progress', 'T8'],
	['Bake test loaves', 'review'],
];
if (requestParts) {
	const taskInput = (title: string, status: BoardTaskInput['status'], parent: string | null = null): BoardTaskInput => ({
		title, status, parent, description: 'An invented bakery task.', acceptance: null, blockedBy: [], blockedReason: null, writeScopes: [],
	});
	const request = await runtime.board.saveTask({ task: taskInput('Publish the spring menu', 'in_progress') }, 'coordinator');
	const imagePath = join(setup.projectDir, 'menu-preview.png');
	await Bun.write(imagePath, Bun.file(new URL('./fixtures/spring-menu.png', import.meta.url)));
	const completedParts = [
		['Write the menu text', 'The menu lists prices and allergens beside each pastry.'],
		['Choose the spring colours', 'The palette uses sage green and warm cream.'],
		['Lay out the printed menu', 'The headings and prices fit on a single page.'],
		['Check the allergy notes', 'The notes match the kitchen’s ingredient list.'],
		['Prepare the shop preview', 'The spring menu fits the shop’s display.'],
	] as const;
	for (const [title, summary] of completedParts) {
		const task = taskInput(title, 'todo', request.id);
		const part = await runtime.board.saveTask({ task }, 'coordinator');
		await runtime.board.writeReport(change => runtime.harness.commit(change, BACKGROUND_CONTEXT), {
			taskId: part.id, sections: { summary, results: `Checked “${title}” against the counter and window menu layouts.` }, by: { author: 'coordinator', threadId: null, workerId: null },
			mergeChecks: [{ name: 'Compare with the spring menu', result: 'passed', at: new Date(clock).toISOString() }],
		}, `request-demo-report-${part.id}`);
		await setup.server.artifacts.save({ projectId, sourcePath: imagePath, title: `${title} preview`, note: 'Synthetic review evidence.', threadId: 'main', workerId: null, taskId: part.id });
		const proofNote = `menu-${part.id.toLowerCase()}.md`;
		await Bun.write(join(setup.projectDir, proofNote), `# ${title}\n\n${summary}\n`);
		git('add', proofNote);
		git('commit', '-m', title, '-m', `Kemiri-Task: ${part.id}`);
		await runtime.taskChanges.declareChanges([git('rev-parse', 'HEAD')], [part.id], 'manual');
		const saved = (await runtime.board.get(true)).tasks.find(row => row.id === part.id)!;
		await runtime.board.saveTask({ taskId: part.id, expectedRevision: saved.revision, task: { ...task, status: 'done' } }, 'coordinator');
		clock += 60_000;
	}
	await runtime.board.writeReport(change => runtime.harness.commit(change, BACKGROUND_CONTEXT), {
		taskId: request.id, sections: { summary: 'A spring menu for the shop window and the counter.' }, by: { author: 'coordinator', threadId: null, workerId: null },
	}, 'request-demo-summary');
	await runtime.board.saveTask({ task: taskInput('Photograph the pastries', 'in_progress', request.id) }, 'coordinator');
	await runtime.board.saveTask({ task: taskInput('Print the menu cards', 'in_progress', request.id) }, 'coordinator');
	const drop = taskInput('Add a second menu insert', 'todo', request.id);
	const dropped = await runtime.board.saveTask({ task: drop }, 'coordinator');
	await runtime.harness.commit(async tx => {
		const state = await tx.doc(BoardDoc, runtime.conversation.id);
		saveTask(state, { taskId: dropped.id, expectedRevision: dropped.revision, task: { ...drop, status: 'dropped' }, author: 'coordinator', reason: 'Everything fits on one page.', now: new Date(clock).toISOString() });
	}, BACKGROUND_CONTEXT);
	const stall = await runtime.board.saveTask({ task: taskInput('Prepare the market stall', 'in_progress') }, 'coordinator');
	await runtime.board.saveTask({ task: taskInput('Choose the sample boxes', 'in_progress', stall.id) }, 'coordinator');
	await runtime.board.saveTask({ task: taskInput('Renew the market permit', 'todo') }, 'coordinator');
	await runtime.board.saveTask({ task: { ...taskInput('Order flour for Saturday', 'waiting'), waitingFor: 'the mill to confirm delivery' } }, 'user');
	await runtime.board.saveTask({ task: taskInput('Price the new loaves', 'done') }, 'user');
	for (const [taskId, body] of [['T2', 'Menu wording checked.'], ['T3', 'Spring colours checked.']] as const) {
		await setup.server.notifications.deliver({ projectId, kind: 'worker_report', workerId: `demo-${taskId}`, title: 'Worker reported', body, taskId });
	}
} else if (needsYouFamilies) {
	for (const [title, status, parent] of familyTasks) {
		await runtime.board.saveTask({ task: { title, description: 'An invented bakery task.', acceptance: null, status, blockedBy: [], blockedReason: null, writeScopes: [], parent: parent ?? null } }, 'coordinator');
	}
	await runtime.board.writeReport(change => runtime.harness.commit(change, BACKGROUND_CONTEXT), {
		taskId: 'T9', sections: { steps: 'Sign the quote and send it back.' }, by: { author: 'coordinator', threadId: null, workerId: null },
	}, 'state-demo-quote');
}
const titles = ['Publish the spring menu', 'Write the menu text', 'Photograph the pastries', 'Print the menu cards', 'Prepare the market stall', 'Order a second awning', 'Repair the big oven', 'Bake the test batch', 'Price the new loaves', 'Tidy the recipe folder', 'Choose the box supplier', 'Fix the till printer', 'Renew the market permit', 'Fill in the permit form', 'Collect the flour delivery'];
const statuses: BoardTaskInput['status'][] = ['in_progress', 'done', 'in_progress', 'todo', 'done', 'todo', 'in_progress', 'todo', 'review', 'in_progress', 'in_progress', 'blocked', 'todo', 'todo', 'waiting'];
for (let i = 0; !requestParts && !needsYouFamilies && i < titles.length; i++) {
	await runtime.board.saveTask({ task: { title: titles[i]!, description: 'An invented bakery task.', acceptance: null, status: statuses[i]!, blockedBy: i === 7 ? ['T7'] : [], blockedReason: i === 11 ? 'The repair run failed twice.' : null, writeScopes: [], parent: [1, 2, 3].includes(i) ? 'T1' : i === 13 ? 'T13' : null, foundWhile: i === 5 ? 'T5' : null, ...(i === 14 ? { waitingFor: 'the mill to confirm delivery' } : {}) } }, i === 1 || i === 4 ? 'user' : 'coordinator');
}
await runtime.harness.commit(async tx => {
	const doc = await tx.doc(BoardDoc, runtime.conversation.id);
	doc.questions.push({ id: 'Q1', revision: 1, kind: 'question', text: 'Paper boxes or tins?', options: ['Paper boxes', 'Tins'], taskId: requestParts ? 'T11' : needsYouFamilies ? 'T1' : 'T11', status: 'open', answer: null, askedAt: new Date(clock).toISOString(), answeredAt: null, threadId: 'main' });
	if (!requestParts && !needsYouFamilies && process.env.DEMO_PART_QUESTION === '1') {
		doc.questions.push({ id: 'Q2', revision: 1, kind: 'question', text: 'Daylight or lamp?', options: ['Daylight', 'Lamp'], blocksWork: true, taskId: 'T3', status: 'open', answer: null, askedAt: new Date(clock).toISOString(), answeredAt: null, threadId: 'main' });
	}
	doc.counters.question = doc.questions.length;
}, BACKGROUND_CONTEXT);
if (requestParts) clock = Date.now() - 5 * 60_000;
const liveTasks = requestParts
	? [['fern', 'T7', 'Pastry photos'], ['moss', 'T8', 'Printed menus']] as const
	: needsYouFamilies
	? [['fern', 'T7', 'Sample boxes'], ['moss', 'T8', 'Oven repair']] as const
	: [['fern', 'T3', 'Pastry photos'], ['moss', 'T7', 'Oven repair']] as const;
for (const [id, taskId, title] of liveTasks) {
	const started = await runtime.threads.start({ id, title, brief: 'Synthetic held session; no tools.', model: null, thinkingLevel: null, onFinish: 'record', startedBy: 'main', scheduleId: null, taskId, key: `state-demo-${id}` });
	if (!started.ok) throw new Error(started.message);
}
// Keep the review family's stored parts in review. Live work and a failed run override their displayed states.
if (needsYouFamilies) await runtime.harness.commit(async tx => {
	const doc = await tx.doc(BoardDoc, runtime.conversation.id);
	for (const id of ['T4', 'T7']) doc.tasks.find(task => task.id === id)!.status = 'review';
	activityTracking(doc, 'T6').deployFailure = {
		text: 'The print shop upload failed twice.', since: new Date(clock).toISOString(), refs: [], targets: [], total: 1,
	};
	doc.deployFeedConfigured = true;
}, BACKGROUND_CONTEXT);
// Advance only after the synthetic live work exists, avoiding an artificial pause episode during seeding.
clock = Date.now();
await Bun.write(output, JSON.stringify({ url: setup.server.url, projectId, pid: process.pid, root: setup.root }));
console.log('Synthetic task-state backend ready.');
process.on('SIGTERM', async () => { client.close(); await setup.cleanup(); process.exit(0); });
await new Promise(() => {});
