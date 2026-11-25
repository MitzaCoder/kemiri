/**
 * Synthetic proof backend for the status/Needs you/question consistency plan (T484). Bun only; everything lives in
 * createSetup's temporary root. It reproduces five shapes seen on a real board, with invented bakery tasks:
 *  T1 stored in_progress, a worker running, feedback being handled, and an older open deploy question (Working + Needs you);
 *  T2 stored todo after 21 minutes of work, an open question, and later feedback already addressed;
 *  T3 stored in_progress with Your steps and nothing running;
 *  T4 stored in_progress whose worker ended more than 15 minutes ago (Paused);
 *  T5 stored todo with feedback marked "handling" and nothing running;
 *  T6 a real question and a worker running at the same time.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { createSetup, TestClient } from '../test/support.ts';
import { askQuestion, replyQuestion, coordinatorWriter, openBoard, workerWriter, writeReportIn } from '../src/board.ts';
import { WorkersDoc } from '../src/workers.ts';
import { activityTracking, endActivitySource } from '../src/task-activity.ts';

const origins = (process.env.DEMO_ORIGINS ?? 'http://localhost:5210').split(',');
const start = Date.now() - 45 * 60_000;
let clock = start;
const at = (minute: number) => { clock = start + minute * 60_000; return new Date(clock).toISOString(); };
const setup = await createSetup({ allowedOrigins: origins, terminals: false, now: () => clock });
setup.faux.setResponses(Array.from({ length: 40 }, () => async request => {
	if (JSON.stringify(request.messages.at(-1)).includes('recycled paper')) await Bun.sleep(15_000);
	return fauxAssistantMessage('Synthetic demo ready.');
}));
const client = await TestClient.open(setup.server); await client.hello();
const added = await client.request({ type: 'projects.add', path: setup.projectDir });
if (added.type !== 'projects.add') throw new Error('Could not add the synthetic project');
const projectId = added.project.id;
await client.request({ type: 'projects.configure', projectId, name: 'Little bakery', coordinatorModel: { provider: 'faux', modelId: 'faux-1' } });
const { runtime } = await setup.server.manager.open(projectId);
const mainId = runtime.conversation.id;
const commit = <R>(change: Parameters<typeof runtime.harness.commit<R>>[0]) => runtime.harness.commit(change, BACKGROUND_CONTEXT);
const by = coordinatorWriter('main');
let serial = 0;

async function task(title: string, description: string, acceptance: string, status: 'todo' | 'in_progress') {
	return runtime.board.saveTask({ task: { title, description, acceptance, status, blockedBy: [], blockedReason: null, writeScopes: [] } }, 'coordinator');
}
async function move(id: string, status: 'todo' | 'in_progress') {
	const current = (await runtime.board.get(true)).tasks.find(candidate => candidate.id === id)!;
	await runtime.board.saveTask({ taskId: id, expectedRevision: current.revision, task: { title: current.title, description: current.description, acceptance: current.acceptance, status, blockedBy: [], blockedReason: null, writeScopes: [] } }, 'coordinator');
}
async function worker(taskId: string, name: string, title: string, since: string, state: 'running' | 'ended', phase?: string) {
	const conversation = await runtime.harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
	const actor = { id: `main:${conversation.id}:1`, kind: 'worker', name, threadId: 'main', conversationId: conversation.id, runId: '1' } as const;
	await commit(async tx => {
		const board = await openBoard(tx, mainId);
		activityTracking(board, taskId).sources[actor.id] = { actor, state: 'running', since, title, ...(phase ? { phase } : {}) };
		const found = board.tasks.find(candidate => candidate.id === taskId)!;
		if (!found.workerIds.includes(name)) found.workerIds.push(name);
		(await tx.doc(WorkersDoc, mainId)).workers[name] = {
			id: name, title, conversationId: conversation.id, status: 'idle', isolation: 'shared', workspacePath: null,
			model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: null, spawnedByCallId: null, createdAt: since, updatedAt: since,
			lastReport: null, failure: null, anchorTaskId: 1,
		} as never;
	});
	return { actor, end: (when: string) => commit(async tx => { endActivitySource(activityTracking(await openBoard(tx, mainId), taskId), actor.id, when); }) };
}
const report = (taskId: string, writer: ReturnType<typeof workerWriter>, when: string, input: Record<string, unknown>) =>
	commit(tx => writeReportIn(tx, mainId, { taskId, sections: {}, by: writer, ...input } as never, `demo:${++serial}`, when));
const ask = (taskId: string, text: string, choices: { label: string; effect: string; recommended?: true }[]) =>
	runtime.board.commitFor(change => commit(change), (state, now) => askQuestion(state, { text, options: choices.map(choice => choice.label), choices, taskId, threadId: 'main', now }), by, `demo-ask:${++serial}`);
async function feedback(taskId: string, text: string, state: 'handling' | 'addressed', note: string) {
	const entry = await runtime.board.recordFeedback({ taskId, text, images: 0, threadId: 'main', requestId: `demo-feedback-${++serial}` });
	clock += 20_000;
	const questions = (await runtime.board.get(true)).questions.filter(q => q.taskId === taskId && q.waitingOn === 'agent');
	if (taskId === 'T1' && questions.length) return; // Keep the question waiting for the demo.
	for (const question of questions) {
		await runtime.board.commitFor(change => commit(change), (board, now) => replyQuestion(board, { questionId: question.id, expectedRevision: question.revision, text: note, by, now }), by, `demo-reply:${++serial}`);
	}
	await runtime.board.setFeedbackFor(change => commit(change), { taskId, feedbackId: entry.id, state, note }, by);
}

// T1: the main case. A worker finished, the coordinator asked whether to deploy, then feedback started new work.
at(0);
const t1 = await task('Show real oven temperatures on the kitchen screen', 'The kitchen screen shows every oven at 0 degrees.\nThe cause will be found and fixed, so the cards show real temperatures.', 'The report names the cause.\nThe cards show real temperatures, or a plain reason when the probe gives none.', 'in_progress');
const first = await worker(t1.id, 'oven-screen-fix', t1.title, at(0), 'running');
await report(t1.id, workerWriter('main', 'oven-screen-fix'), at(18), { sections: { summary: 'The probe answered with placeholder readings, which the screen showed as 0 degrees; now the cards say Temperature unavailable with the reason.' }, addResult: 'The cards now say Temperature unavailable instead of a fake 0 degrees.' });
await first.end(at(19));
await report(t1.id, by, at(20), { sections: { next: "After the owner's deploy answer, main lands it." } });
await ask(t1.id, 'Should the honest oven temperature cards go live?\nInstead of a fake 0 degrees, they say Temperature unavailable because the probe returns placeholder readings.\nIt changes the kitchen screen and the phone app.', [
	{ label: 'Deploy screen only', effect: 'Main pushes it, and the phone gets it with the next install.', recommended: true },
	{ label: 'Deploy screen and phone', effect: 'Main pushes it, and a worker installs the app on the phone.' },
	{ label: 'Wait', effect: 'It stays off main until the owner says so.' },
]);
at(32);
await feedback(t1.id, "Let's update the probe firmware then, maybe that's the issue.", 'handling', 'A worker is checking for newer probe firmware and testing whether it reports real temperatures.\nIf it does, the worker updates the pinned version, and the cards will then show live values after the deploy.');
const second = await worker(t1.id, 'probe-update', 'Update the probe firmware', at(33), 'running');
const probe = workerWriter('main', 'probe-update');
await report(t1.id, probe, at(34), { sections: { now: 'Checking the newest probe firmware' }, planUpdate: { plan: [{ text: 'Find the newest probe firmware and the pinned version' }, { text: 'Compare readings with the new firmware' }, { text: 'Update the pin only if it helps' }, { text: 'Run checks and commit the result' }] } });
await report(t1.id, probe, at(37), { sections: { now: 'Comparing readings with the new firmware' }, addResult: 'The maker publishes firmware 1.5.17. The current pin is 1.5.12.', planUpdate: { tick: [1] } });
await report(t1.id, probe, at(41), { sections: { now: 'Running checks and collecting proof' }, planUpdate: { tick: [2, 3] } });
void second;

// T2: a finished study that waits for a decision. The later feedback was answered, and the question still stands.
at(2);
const t2 = await task('Find why the ovens waste heat and plan a fix', 'The ovens reheat from cold too often, which wastes gas.\nA study finds when and why, and proposes fixes. Nothing is built until the owner picks.', 'A plan page ranks the causes by cost.\nThe owner gets one question with the recommended choices.', 'in_progress');
const study = await worker(t2.id, 'heat-study', t2.title, at(2), 'running');
await report(t2.id, workerWriter('main', 'heat-study'), at(22), { sections: { summary: 'Reheating from cold costs about 18% of the gas bill, and four small fixes would save most of it.' } });
await study.end(at(23));
await move(t2.id, 'todo');
await report(t2.id, by, at(23), { sections: { next: 'After the owner answers, workers build stages 1 to 3 in parallel.' } });
await ask(t2.id, 'Should the heat fixes be built as the study recommends?\nKeep the ovens warm between batches, fix the door seal and add a heat line to the daily sheet.', [
	{ label: 'Build as recommended', effect: 'Workers build the four fixes, patching the oven controller here and reporting it to the maker.', recommended: true },
	{ label: 'Build only our fixes', effect: 'The controller fix waits for the maker.' },
	{ label: 'Wait', effect: 'Nothing is built until the owner comments on the plan page.' },
]);
at(38);
await feedback(t2.id, "So, the oven maker doesn't have an update that solves this?", 'addressed', 'No, not that main could find.\nThe newest controller release is already installed, and the waste continued on it.\nSo patching here and reporting it to the maker, as the plan recommends, is still the way to get the saving now.');

// T3: Your steps hide that the task is stored as in progress with nothing running.
at(4);
const t3 = await task('Turn on the delivery alerts at the market stall', 'Alerts for late flour deliveries reach the stall tablet.', 'The owner confirms an alert arrives on the tablet.', 'in_progress');
const stall = await worker(t3.id, 'stall-alerts', t3.title, at(4), 'running');
await stall.end(at(12));
await report(t3.id, by, at(12), { sections: { steps: '1. Wake the stall tablet and connect it to the shop network.\n\n2. Open the app and check that a test alert arrives.', next: "Agents have nothing left to do; the owner's steps confirm delivery." } });

// T4: stored in progress; its last run is old enough to show Paused.
at(6);
const t4 = await task('Find why the till app stutters and plan a fix', 'Scrolling the order list stutters on the till.', 'A plan page names the causes and the fixes.', 'in_progress');
const till = await worker(t4.id, 'till-study', t4.title, at(6), 'running');

// T5: stored to do; feedback is marked as being handled, but no work runs for it.
at(8);
const t5 = await task('Plan how the shop spots a fast gas drain', 'A plan for noticing unusual gas use within the hour.', 'A plan page with the recommended choices.', 'todo');
at(15);
await feedback(t5.id, 'Comments on the plan page: use the hourly reading, not the daily one.', 'handling', 'The comments arrived, so the build runs on its own task.');

at(39);
const t6 = await task('Move the order sheet to the new printer', 'The new printer needs the order sheet template.', 'Print a test order.', 'in_progress');
await worker(t6.id, 'printer-move', t6.title, at(40), 'running', 'setting up the new printer');
await report(t6.id, workerWriter('main', 'printer-move'), at(41), { sections: { now: 'Setting up the new printer' }, planUpdate: { plan: [{ text: 'Install the printer driver', status: 'done' }, { text: 'Move the sheet template', status: 'doing' }, { text: 'Print a test order' }] }, addResult: 'The driver is installed on the till.' });
await ask(t6.id, 'Should old order sheets be reprinted in the new format?', [
	{ label: 'Only new orders', effect: 'Old sheets stay as they are.', recommended: true },
	{ label: 'Reprint all', effect: 'About 300 sheets are printed again.' },
]);
await till.end(at(25));
clock = start + 45 * 60_000;
// Ages continue to tick from the seeded timeline.
const offset = clock - Date.now();
const live = setInterval(() => { clock = Date.now() + offset; }, 1000);
const connection = JSON.stringify({ url: setup.server.url, projectId, pid: process.pid, root: setup.root });
if (process.env.DEMO_OUTPUT) await Bun.write(process.env.DEMO_OUTPUT, connection);
console.log(connection);
process.on('SIGTERM', async () => { clearInterval(live); client.close(); await setup.cleanup(); process.exit(0); });
await new Promise(() => {});
