/** Synthetic coordinator proof backend. Run from the repository root with Bun. */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { createSetup, TestClient } from '../test/support.ts';
import { askQuestion, openBoard, saveTask } from '../src/board.ts';
import { ThreadsDoc } from '../src/threads.ts';

const origins = (process.env.DEMO_ORIGINS ?? 'http://localhost:5173').split(',');
const setup = await createSetup({ allowedOrigins: origins, terminals: false });
const client = await TestClient.open(setup.server);
process.on('SIGTERM', async () => { client.close(); await setup.cleanup(); process.exit(0); });
setup.faux.setResponses(Array.from({ length: 100 }, () => fauxAssistantMessage('The spring menu is ready to review. The preorder work and its remaining decisions are on the board.')));
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
await runtime.harness.commit(async tx => {
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
}, BACKGROUND_CONTEXT);
await runtime.threads.hold(marketing.id, true, 'demo-pause');
await client.request({ type: 'conversation.submit', projectId, threadId: shop.id, requestId: 'demo-greeting', content: 'How is the spring preorder menu coming along?' });
await Bun.write(process.env.DEMO_OUTPUT ?? '/tmp/coordinators-demo.json', JSON.stringify({ url: setup.server.url, projectId, shop: shop.id, pid: process.pid }));
console.log('Coordinator demo ready');
await new Promise(() => {});
