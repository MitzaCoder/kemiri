/** Synthetic task usage backend. Run from the repo root with Bun. */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { HARNESS_FEATURES } from '@kemiri/protocol';
import { BoardDoc } from '../src/board.ts';
import { ConversationRequests } from '../src/request-log.ts';
import type { RequestBilling } from '../src/request-log-store.ts';
import { createSetup, TestClient } from '../test/support.ts';

const origins = (process.env.DEMO_ORIGINS ?? 'http://localhost:5173').split(',');
const setup = await createSetup({ allowedOrigins: origins, terminals: false,
	...(process.env.DEMO_LEGACY === '1' ? { features: HARNESS_FEATURES.filter(feature => feature !== 'task-usage') } : {}),
});
const client = await TestClient.open(setup.server);
async function cleanup() { client.close(); await setup.cleanup(); }
process.once('SIGTERM', async () => { await cleanup(); process.exit(0); });
process.once('SIGINT', async () => { await cleanup(); process.exit(0); });
try {
	await client.hello();
	const added = await client.request({ type: 'projects.add', path: setup.projectDir });
	if (added.type !== 'projects.add') throw new Error('Could not add demo project');
	const projectId = added.project.id;
	await client.request({ type: 'projects.configure', projectId, name: 'Paper Observatory', coordinatorModel: { provider: 'faux', modelId: 'faux-1' } });
	const { runtime } = await setup.server.manager.open(projectId);
	for (const [title, parent] of [['Print the pocket star atlas', null], ['Draw the constellation maps', 'T1'], ['Check the winter sky map', 'T2'], ['File the spare colour swatches', null]] as const) {
		await runtime.board.saveTask({ task: { title, parent, description: 'A sample task for the paper observatory.', status: 'done',
			acceptance: null, blockedBy: [], blockedReason: null, writeScopes: [] } }, 'coordinator');
	}
	await runtime.harness.commit(async tx => {
		const board = await tx.doc(BoardDoc, runtime.conversation.id);
		board.tasks[0]!.report.results = 'The pocket atlas is ready to print. The winter map has larger labels and a clearer legend.';
	}, BACKGROUND_CONTEXT);
	const store = setup.server.requestLog?.store;
	if (!store) throw new Error('Task usage demo needs a request log');
	const start = Date.now() - 30 * 60_000;
	function reading(provider: string, at: number, usedPercent: number) {
		store!.ledger.reading(provider, { id: 'week', label: 'Weekly limit', windowMinutes: 10_080,
			usedPercent, resetsAt: new Date(start + 7 * 86_400_000).toISOString(), source: 'usage_api' }, at);
	}
	let conversationId = 0;
	function request(taskId: string | null, workerId: string | null, provider: string, model: string, billing: RequestBilling, cost: number, priced = true) {
		store!.insert({ ...new ConversationRequests({ projectId, conversationId: ++conversationId,
			identity: { kind: workerId ? 'worker' : 'main', taskId, workerId, threadId: 'main', scheduleId: null },
		}).request({ provider, model, timestamp: start + 60_000, usage: { input: 120, cost: { total: cost } } },
		{ wake: 'user', retention: 'short', changes: null, source: 'live' }), billing, priced });
	}
	reading('Orchard', start, 0);
	reading('Meadow', start, 0);
	request('T1', 'atlas', 'Orchard', 'spruce-2', 'subscription', 20);
	request('T2', 'mapmaker', 'Orchard', 'spruce-2', 'subscription', 10);
	request('T3', 'proofreader', 'Orchard', 'spruce-2', 'subscription', 5);
	request(null, null, 'Orchard', 'spruce-2', 'subscription', 15);
	request('T2', 'mapmaker', 'Meadow', 'clover-3', 'plan_key', 6.18);
	request('T2', 'mapmaker', 'Meadow', 'clover-3', 'plan_key', 0, false);
	request('T3', 'proofreader', 'Metered', 'pebble-1', 'api_key', 0.62);
	reading('Orchard', start + 2 * 60_000, 10);
	reading('Meadow', start + 2 * 60_000, 3);
	const ready = JSON.stringify({ url: setup.server.url, projectId, taskId: 'T1', pid: process.pid, root: setup.root });
	if (process.env.DEMO_OUTPUT) await Bun.write(process.env.DEMO_OUTPUT, ready);
	console.log(ready);
	await new Promise(() => {});
} finally { await cleanup(); }
