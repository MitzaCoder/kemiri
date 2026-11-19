/** Synthetic Live proof: SIGUSR1 advances the plan/check, SIGUSR2 folds, SIGWINCH adds recorded work for a news line. */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { HARNESS_FEATURES } from '@kemiri/protocol';
import { createSetup, TestClient } from '../test/support.ts';
import { foldTaskLiveIn, openBoard, workerWriter, writeReportIn } from '../src/board.ts';
import { LiveDoc, type TaskId } from '@earendil-works/pi-durable';
import { WorkersDoc } from '../src/workers.ts';
import { activityTracking, endActivitySource } from '../src/task-activity.ts';

const features = HARNESS_FEATURES.filter(feature => (process.env.DEMO_BEFORE !== '1' || feature !== 'task-live') && (process.env.DEMO_STAGE_C !== '1' || feature !== 'task-live-watcher'));
const setup = await createSetup({ features, allowedOrigins: (process.env.DEMO_ORIGINS ?? 'http://localhost:5210').split(','), terminals: false });
setup.faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("Synthetic demo ready.")));
const client = await TestClient.open(setup.server);
await client.hello();
const added = await client.request({ type: 'projects.add', path: setup.projectDir });
if (added.type !== 'projects.add') throw new Error('Could not add the synthetic project');
const projectId = added.project.id;
await client.request({ type: 'projects.configure', projectId, name: 'Little bakery', coordinatorModel: { provider: 'faux', modelId: 'faux-1' } });
const { runtime } = await setup.server.manager.open(projectId);
const task = await runtime.board.saveTask({ task: { title: 'Make gift cards work at checkout', description: 'Let shoppers pay for part or all of an order with a gift card.', acceptance: 'A gift card can pay for part or all of an order.', status: 'in_progress', blockedBy: [], blockedReason: null, writeScopes: [] } }, 'user');
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const mainId = runtime.conversation.id;
const fixture = await runtime.harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
const actor = await runtime.harness.commit(async tx => {
 const append = (name: string, args: Record<string, string>, isError = false) => appendFinishedCall(tx, name, args, isError);
 const first = await append('read', { path: 'checkout.ts' });
 await append('edit', { path: 'checkout.ts' });
 await append('write', { path: 'balance.ts' });
 await append('bash', { command: 'bun test checkout' }, true);
 await append('bash', { command: "git commit -m 'Add gift card checkout'" });
 const live = await tx.doc(LiveDoc, fixture.id);
 live.run = { first, taskId: 1 as TaskId, inputs: [], turns: 0 };
 const actor = { id: `main:${fixture.id}:${first}`, kind: 'worker', name: 'fern', threadId: 'main', conversationId: fixture.id, runId: String(first) } as const;
 const board = await openBoard(tx, mainId);
 activityTracking(board, task.id).sources[actor.id] = { actor, state: 'running', since: at(23), title: task.title };
 // Register a synthetic transcript route without starting a real worker or its check-ins.
 (await tx.doc(WorkersDoc, mainId)).workers.fern = {
  id: 'fern', title: task.title, conversationId: fixture.id, status: 'idle',
  isolation: 'shared', workspacePath: null, model: { provider: 'faux', modelId: 'faux-1' }, thinkingLevel: null,
  spawnedByCallId: null, createdAt: at(23), updatedAt: at(0), lastReport: null, failure: null, anchorTaskId: 1,
 };
 return actor;
}, BACKGROUND_CONTEXT);

async function appendFinishedCall(tx: import('@earendil-works/pi-durable').Tx, name: string, args: Record<string, string>, isError: boolean) {
 const call = fauxToolCall(name, args);
 const entry = await tx.appendEntry(fixture.id, { kind: 'pi.assistant', model: [fauxAssistantMessage([call], { stopReason: 'toolUse' })] });
 await tx.appendEntry(fixture.id, { kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: call.id, toolName: name, isError, timestamp: Date.now(), content: [] }] });
 return entry.id;
}
let serial = 0;
const write = (minutesAgo: number, now?: string, addResult?: string) => runtime.harness.commit(tx => writeReportIn(tx, mainId, {
 taskId: task.id, sections: { now }, addResult, by: workerWriter('main', 'fern'),
}, `demo:${++serial}`, at(minutesAgo)), BACKGROUND_CONTEXT);
await write(21, 'reading the payment flow');
await write(15, 'building the gift card field', 'The checkout now accepts a gift card code.');
await write(8, 'checking partial payments', 'A card can cover part of an order.');
await write(3, 'checking the balance display');
if (features.includes('task-live')) await runtime.harness.commit(tx => writeReportIn(tx, mainId, {
 taskId: task.id, sections: {}, by: workerWriter('main', 'fern'),
 planUpdate: { plan: [
  { text: 'Trace the checkout payment flow' }, { text: 'Add gift cards to checkout' },
  { text: 'Check partial payments' }, { text: 'Run the checkout tests' }, { text: 'Capture a checkout receipt' },
 ], tick: [1, 2] },
}, `demo:${++serial}`, at(2)), BACKGROUND_CONTEXT);
let signalCount = 0;
process.on('SIGUSR1', () => { void runtime.harness.commit(async tx => {
 if (signalCount++ === 0) {
  if (features.includes('task-live')) await writeReportIn(tx, mainId, {
   taskId: task.id, sections: {}, by: workerWriter('main', 'fern'), planUpdate: { tick: [3] },
  }, `demo:${++serial}`, at(0));
  const call = fauxToolCall('bash', { command: 'bun test checkout-gift-cards', intent: 'Verify gift card payments' });
  await tx.appendEntry(fixture.id, { kind: 'pi.assistant', model: [fauxAssistantMessage([call], { stopReason: 'toolUse' })] });
  (await tx.doc(LiveDoc, fixture.id)).tools = [{ callId: call.id, name: call.name, status: 'running', taskId: 2 as TaskId }];
 } else {
  await writeReportIn(tx, mainId, { taskId: task.id, sections: {}, mergeChecks: [{ name: 'Gift card checkout tests', result: 'passed', count: 24 }], by: workerWriter('main', 'fern') }, `demo:${++serial}`, at(0));
 }
}, BACKGROUND_CONTEXT); });
process.on('SIGWINCH', () => { void runtime.harness.commit(async tx => {
 await appendFinishedCall(tx, 'read', { path: 'checkout.ts' }, false);
 for (let i = 0; i < 4; i++) await appendFinishedCall(tx, 'edit', { path: 'gift-card-balance-display.ts' }, false);
 await appendFinishedCall(tx, 'write', { path: 'balance-display.test.ts' }, false);
 await appendFinishedCall(tx, 'bash', { command: 'bun test tests/balance-display.test.ts', intent: 'Check that partial payments show the remaining balance' }, false);
 // Stage B observes changes to the durable tool slots, then reads the committed events.
 const call = fauxToolCall('read', { path: 'checkout.ts' });
 await tx.appendEntry(fixture.id, { kind: 'pi.assistant', model: [fauxAssistantMessage([call], { stopReason: 'toolUse' })] });
 (await tx.doc(LiveDoc, fixture.id)).tools = [{ callId: call.id, name: call.name, status: 'running', taskId: 3 as TaskId }];
}, BACKGROUND_CONTEXT); });
process.on('SIGUSR2', () => { void runtime.harness.commit(async tx => {
 const board = await openBoard(tx, mainId);
 const live = await tx.doc(LiveDoc, fixture.id);
 delete live.run;
 delete live.tools;
 endActivitySource(activityTracking(board, task.id), actor.id, at(0));
 await foldTaskLiveIn(tx, mainId, board, task.id, actor.id, 'reported', at(0));
}, BACKGROUND_CONTEXT); });
process.on('SIGTERM', async () => { client.close(); await setup.cleanup(); process.exit(0); });
const connection = JSON.stringify({ url: setup.server.url, projectId, taskId: task.id, pid: process.pid });
if (process.env.DEMO_OUTPUT) await Bun.write(process.env.DEMO_OUTPUT, connection);
console.log(connection);
await new Promise(() => {});
