/** Synthetic task-state proof backend. Bun only; all data/config live in createSetup's temporary root. */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { createSetup, TestClient, ViewClient } from '../test/support.ts';
import { BoardDoc } from '../src/board.ts';
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
const client = await TestClient.open(setup.server); await client.hello();
const added = await client.request({ type: 'projects.add', path: setup.projectDir });
if (added.type !== 'projects.add') throw new Error('Could not add synthetic project');
const projectId = added.project.id;
await client.request({ type: 'projects.configure', projectId, name: 'Little bakery', coordinatorModel: { provider: 'faux', modelId: 'faux-1' } });
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
if (needsYouFamilies) {
	for (const [title, status, parent] of familyTasks) {
		await runtime.board.saveTask({ task: { title, description: 'An invented bakery task.', acceptance: null, status, blockedBy: [], blockedReason: null, writeScopes: [], parent: parent ?? null } }, 'coordinator');
	}
	await runtime.board.writeReport(change => runtime.harness.commit(change, BACKGROUND_CONTEXT), {
		taskId: 'T9', sections: { steps: 'Sign the quote and send it back.' }, by: { author: 'coordinator', threadId: null, workerId: null },
	}, 'state-demo-quote');
}
const titles = ['Publish the spring menu', 'Write the menu text', 'Photograph the pastries', 'Print the menu cards', 'Prepare the market stall', 'Order a second awning', 'Repair the big oven', 'Bake the test batch', 'Price the new loaves', 'Tidy the recipe folder', 'Choose the box supplier', 'Fix the till printer', 'Renew the market permit', 'Fill in the permit form', 'Collect the flour delivery'];
const statuses: BoardTaskInput['status'][] = ['in_progress', 'done', 'in_progress', 'todo', 'done', 'todo', 'in_progress', 'todo', 'review', 'in_progress', 'in_progress', 'blocked', 'todo', 'todo', 'waiting'];
for (let i = 0; !needsYouFamilies && i < titles.length; i++) {
	await runtime.board.saveTask({ task: { title: titles[i]!, description: 'An invented bakery task.', acceptance: null, status: statuses[i]!, blockedBy: i === 7 ? ['T7'] : [], blockedReason: i === 11 ? 'The repair run failed twice.' : null, writeScopes: [], parent: [1, 2, 3].includes(i) ? 'T1' : i === 13 ? 'T13' : null, foundWhile: i === 5 ? 'T5' : null, ...(i === 14 ? { waitingFor: 'the mill to confirm delivery' } : {}) } }, i === 1 || i === 4 ? 'user' : 'coordinator');
}
await runtime.harness.commit(async tx => {
	const doc = await tx.doc(BoardDoc, runtime.conversation.id);
	doc.questions.push({ id: 'Q1', revision: 1, kind: 'question', text: 'Paper boxes or tins?', options: ['Paper boxes', 'Tins'], taskId: needsYouFamilies ? 'T1' : 'T11', status: 'open', answer: null, askedAt: new Date(clock).toISOString(), answeredAt: null, threadId: 'main' });
	if (!needsYouFamilies && process.env.DEMO_PART_QUESTION === '1') {
		doc.questions.push({ id: 'Q2', revision: 1, kind: 'question', text: 'Daylight or lamp?', options: ['Daylight', 'Lamp'], blocksWork: true, taskId: 'T3', status: 'open', answer: null, askedAt: new Date(clock).toISOString(), answeredAt: null, threadId: 'main' });
	}
	doc.counters.question = doc.questions.length;
}, BACKGROUND_CONTEXT);
const liveTasks = needsYouFamilies
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
