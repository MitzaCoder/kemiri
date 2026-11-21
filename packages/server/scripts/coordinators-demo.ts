/** Synthetic coordinator proof backend. Run from the repository root with Bun. */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createSetup, TestClient } from '../test/support.ts';
import { askQuestion, openBoard, saveTask } from '../src/board.ts';
import { ThreadsDoc } from '../src/threads.ts';

const origins = (process.env.DEMO_ORIGINS ?? 'http://localhost:5173').split(',');
const setup = await createSetup({ allowedOrigins: origins, terminals: false });
const client = await TestClient.open(setup.server);
process.on('SIGTERM', async () => { client.close(); await setup.cleanup(); process.exit(0); });
await client.hello();
const added = await client.request({ type: 'projects.add', path: setup.projectDir });
if (added.type !== 'projects.add') throw new Error(JSON.stringify(added));
const projectId = added.project.id;
const model = { provider: 'faux', modelId: 'faux-1' };
await client.request({ type: 'projects.configure', projectId, name: 'Lumen Bakery', coordinatorModel: model, workerModels: [model] });
const { runtime } = await setup.server.manager.open(projectId);
await runtime.threads.update('main', { area: 'Bakery operations, planning, and work without a home.', color: '#7e8ca4' });
const shop = await runtime.threads.create({ title: 'Web shop', area: 'The storefront, seasonal menus, and online checkout.', color: '#5087dc', paths: ['apps/shop/**'] }, 'demo-shop');
const kitchen = await runtime.threads.create({ title: 'Kitchen API', area: 'Inventory and the order API used by the bakers.', color: '#279c8e' }, 'demo-kitchen');
const deliveries = await runtime.threads.create({ title: 'Deliveries', area: 'Pickup windows, courier routes, and packaging.', color: '#ba8036' }, 'demo-deliveries');
const marketing = await runtime.threads.create({ title: 'Marketing', area: 'Seasonal photography, newsletters, and the bakery story.', color: '#d2688c' }, 'demo-marketing');
const job = await runtime.threads.create({ title: 'Audit product photos', area: 'Check the image sizes for the spring menu.' }, 'demo-photo-audit');
const { menu, stock } = await runtime.harness.commit(async tx => {
	const doc = await tx.doc(ThreadsDoc, runtime.conversation.id);
	doc.threads[job.id]!.kind = 'job';
	doc.threads[job.id]!.parentThreadId = shop.id;
	const board = await openBoard(tx, runtime.conversation.id);
	const now = new Date().toISOString();
	function task(title: string, ownerThreadId: string | null, status: 'todo' | 'in_progress' | 'blocked' | 'review' = 'todo', parent?: string, blockedBy: string[] = []) {
		return saveTask(board, { task: { title, description: 'A sample task for the spring market.', acceptance: null, status, blockedBy, blockedReason: null, writeScopes: [], parent, goal: 'change' }, ownerThreadId, author: 'user', now }).after.id;
	}
	const menu = task('Launch the spring preorder menu', shop.id, 'in_progress');
	const stock = task('Publish daily bake quantities', kitchen.id, 'in_progress', menu);
	task('Photograph the spring pastries', marketing.id, 'todo', menu);
	task('Show sold-out items at checkout', shop.id, 'blocked', undefined, [stock]);
	task('Polish the gift-note field', shop.id, 'review');
	const route = task('Confirm the Saturday pickup route', deliveries.id);
	const newsletter = task('Draft the spring newsletter', marketing.id);
	const boxes = task('Choose the sample box supplier', null);
	task('Print the price cards', null);
	task('Check the allergy labels', kitchen.id);
	for (const [threadId, taskId, text, options] of [
		['main', boxes, 'Paper boxes or reusable tins?', ['Paper boxes', 'Reusable tins']],
		[shop.id, menu, 'Should sold-out pastries stay visible on the preorder menu?', ['Keep them visible', 'Hide them']],
		[kitchen.id, stock, 'How many extra loaves should we reserve for walk-ins?', ['Six loaves', 'Twelve loaves']],
		[deliveries.id, route, 'Open the first pickup window at eight or nine?', ['Eight', 'Nine']],
		[marketing.id, newsletter, 'Lead with the lemon buns or the cardamom knots?', ['Lemon buns', 'Cardamom knots']],
	] as const) askQuestion(board, { threadId, taskId, text, options, now });
	return { menu, stock };
}, BACKGROUND_CONTEXT);
await runtime.threads.hold(marketing.id, true, 'demo-pause');
const send = (id: string, message: string, kind: 'request' | 'reply' | 'note', taskId: string, awaitReply = false) =>
	fauxAssistantMessage([fauxToolCall('thread_send', { id, message, kind, taskId, awaitReply })], { stopReason: 'toolUse' });
setup.faux.setResponses(Array.from({ length: 100 }, () => request => {
	const last = request.messages.findLast(message => message.role !== 'system');
	const text = last && 'content' in last && typeof last.content === 'string' ? last.content : '';
	if (text.includes('How is the spring preorder menu')) return send(kitchen.id, 'What bake quantities can the preorder menu show?', 'request', stock, true);
	if (text.includes('What bake quantities can the preorder menu show?')) return send(shop.id, 'The first batch will have 24 lemon buns and 18 cardamom knots.', 'reply', stock);
	if (text.includes('Could you check the pickup labels?')) return send(kitchen.id, 'Can the kitchen confirm the new pickup labels?', 'request', menu, true);
	if (text.includes('Share the preorder note.')) return send(shop.id, 'Saturday preorders close at 6 pm on Friday.', 'note', menu);
	if (text.includes('Ask the kitchen for a live update.')) return send(kitchen.id, 'Do we have enough paper bags for the spring pickup?', 'request', menu, true);
	return fauxAssistantMessage('');
}));
async function submit(threadId: string, requestId: string, content: string) {
	await client.request({ type: 'conversation.submit', projectId, threadId, requestId, content });
	await (await runtime.threads.conversation(threadId)).waitForIdle(BACKGROUND_CONTEXT);
}
await submit(shop.id, 'demo-greeting', 'How is the spring preorder menu coming along?');
await (await runtime.threads.conversation(kitchen.id)).waitForIdle(BACKGROUND_CONTEXT);
await (await runtime.threads.conversation(shop.id)).waitForIdle(BACKGROUND_CONTEXT);
await submit(shop.id, 'demo-awaiting', 'Could you check the pickup labels?');
await (await runtime.threads.conversation(kitchen.id)).waitForIdle(BACKGROUND_CONTEXT);
await submit(kitchen.id, 'demo-note', 'Share the preorder note.');
await Bun.write(process.env.DEMO_OUTPUT ?? '/tmp/coordinators-demo.json', JSON.stringify({ url: setup.server.url, projectId, shop: shop.id, kitchen: kitchen.id, task: stock, pid: process.pid }));
console.log('Coordinator demo ready');
await new Promise(() => {});
