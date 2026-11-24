/** Synthetic backend for chat-header proof: several coordinators, areas, questions waiting and a running app. */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { createSetup, TestClient } from '../test/support.ts';
import { askQuestion, openBoard, saveTask } from '../src/board.ts';
import { fakeTailscale } from '../test/fake-tailscale.ts';

const origins = (process.env.DEMO_ORIGINS ?? 'http://localhost:5173').split(',');
const setup = await createSetup({ allowedOrigins: origins, ...(process.env.DEMO_TERMINALS ? {} : { terminals: false as const }), appTailscale: fakeTailscale().tailscale });
const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<h1>Orders preview</h1>', { headers: { 'content-type': 'text/html' } }) });
const client = await TestClient.open(setup.server);
process.on('SIGTERM', async () => { client.close(); listener.stop(true); await setup.cleanup(); process.exit(0); });
await client.hello();
const added = await client.request({ type: 'projects.add', path: setup.projectDir });
if (added.type !== 'projects.add') throw new Error(JSON.stringify(added));
const projectId = added.project.id;
const model = { provider: 'faux', modelId: 'faux-1' };
await client.request({ type: 'projects.configure', projectId, name: 'lumen-core-services', coordinatorModel: model, workerModels: [model] });
const { runtime } = await setup.server.manager.open(projectId);
await runtime.threads.update('main', { area: 'Planning and work without a home.', color: '#7e8ca4' });
const builder = await runtime.threads.create({ title: 'Order Builder', area: 'Work done on the Order Builder of the Lumen Bakery platform.', color: '#5087dc' }, 'demo-builder');
const review = await runtime.threads.create({ title: 'Code Review', area: 'Reviews changes before they land.', color: '#d2688c' }, 'demo-review');
await runtime.harness.commit(async tx => {
	const board = await openBoard(tx, runtime.conversation.id);
	const now = new Date().toISOString();
	const task = (title: string, ownerThreadId: string | null, status: 'todo' | 'in_progress' = 'in_progress') =>
		saveTask(board, { task: { title, description: 'A sample task.', acceptance: null, status, blockedBy: [], blockedReason: null, writeScopes: [], goal: 'change' }, ownerThreadId, author: 'user', now }).after.id;
	for (const [title, text, options] of [
		['Launch the spring preorder menu', 'Should sold-out pastries stay visible?', ['Keep them visible', 'Hide them']],
		['Publish daily bake quantities', 'How many extra loaves for walk-ins?', ['Six', 'Twelve']],
		['Polish the gift-note field', 'Limit the gift note to 120 characters?', ['Yes', 'No']],
		['Check the allergy labels', 'Show allergens on the receipt too?', ['Yes', 'No']],
	] as const) askQuestion(board, { threadId: builder.id, taskId: task(title, builder.id), text, options, now });
	task('Review the checkout change', review.id, 'todo');
	task('Print the price cards', null, 'todo');
}, BACKGROUND_CONTEXT);
setup.faux.setResponses(Array.from({ length: 20 }, () => () => fauxAssistantMessage('The preorder menu is on track. Four questions are waiting for the owner on the board.')));
await client.request({ type: 'conversation.submit', projectId, threadId: builder.id, requestId: 'demo-greeting', content: 'How is the spring preorder menu coming along?' });
await (await runtime.threads.conversation(builder.id)).waitForIdle(BACKGROUND_CONTEXT);
for (const [index, content] of ['Which pastries sell out first?', 'Is the gift-note field ready?', 'What is left before launch?'].entries()) {
	await client.request({ type: 'conversation.submit', projectId, threadId: builder.id, requestId: `demo-more-${index}`, content });
	await (await runtime.threads.conversation(builder.id)).waitForIdle(BACKGROUND_CONTEXT);
}
await client.request({ type: 'apps.settings.set', settings: { addresses: { mode: 'template', template: 'http://oven.example.test:{port}' }, policy: 'on' } });
await setup.server.manager.apps!.publish(projectId, { name: 'Order form preview', port: listener.port! }, { publisher: {
	kind: 'coordinator', id: builder.id, threadId: builder.id, conversationId: (await runtime.threads.conversation(builder.id)).id,
} }, runtime.activeApps);
// A turn that never answers keeps the coordinator's Working mark on screen.
if (process.env.DEMO_WORKING) {
	setup.faux.setResponses([() => new Promise<never>(() => {})]);
	await client.request({ type: 'conversation.submit', projectId, threadId: builder.id, requestId: 'demo-working', content: 'Check the allergy labels once more.' });
}
await Bun.write(process.env.DEMO_OUTPUT ?? '/tmp/chat-header-demo.json', JSON.stringify({ url: setup.server.url, projectId, builder: builder.id, review: review.id, pid: process.pid }));
console.log('Chat header demo ready');
await new Promise(() => {});
