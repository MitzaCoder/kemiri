/** Synthetic Live proof. DEMO_BEFORE=1 omits task-live; SIGUSR1 adds a line, SIGUSR2 ends the run. */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { HARNESS_FEATURES } from '@kemiri/protocol';
import { createSetup, TestClient } from '../test/support.ts';
import { foldTaskLiveIn, openBoard, workerWriter, writeReportIn } from '../src/board.ts';
import { activityTracking, endActivitySource } from '../src/task-activity.ts';

const features = HARNESS_FEATURES.filter(feature => process.env.DEMO_BEFORE !== '1' || feature !== 'task-live');
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
const actor = { id: 'main:102:demo', kind: 'worker', name: 'fern', threadId: 'main', conversationId: 102, runId: 'demo' } as const;
await runtime.harness.commit(async tx => {
 const board = await openBoard(tx, mainId);
 activityTracking(board, task.id).sources[actor.id] = { actor, state: 'running', since: at(23), title: task.title };
}, BACKGROUND_CONTEXT);
let serial = 0;
const write = (minutesAgo: number, now?: string, addResult?: string) => runtime.harness.commit(tx => writeReportIn(tx, mainId, {
 taskId: task.id, sections: { now }, addResult, by: workerWriter('main', 'fern'),
}, `demo:${++serial}`, at(minutesAgo)), BACKGROUND_CONTEXT);
await write(21, 'reading the payment flow');
await write(15, 'building the gift card field', 'The checkout now accepts a gift card code.');
await write(8, 'checking partial payments', 'A card can cover part of an order.');
await write(3, 'checking the balance display');
process.on('SIGUSR1', () => { void write(0, serial > 4 ? 'running the checkout checks' : 'checking an empty card', serial > 4 ? undefined : 'An empty card now explains why it cannot be used.'); });
process.on('SIGUSR2', () => { void runtime.harness.commit(async tx => {
 const board = await openBoard(tx, mainId);
 endActivitySource(activityTracking(board, task.id), actor.id, at(0));
 await foldTaskLiveIn(tx, mainId, board, task.id, actor.id, 'reported', at(0));
}, BACKGROUND_CONTEXT); });
process.on('SIGTERM', async () => { client.close(); await setup.cleanup(); process.exit(0); });
const connection = JSON.stringify({ url: setup.server.url, projectId, taskId: task.id, pid: process.pid });
if (process.env.DEMO_OUTPUT) await Bun.write(process.env.DEMO_OUTPUT, connection);
console.log(connection);
await new Promise(() => {});
