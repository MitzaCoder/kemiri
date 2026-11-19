/** Seed a disposable Value tab demo. No provider calls or persistent backend data. */
import { createProvider } from '@earendil-works/pi-ai';
import { lazyApi } from '@earendil-works/pi-ai/api/lazy';
import { createSetup, TestClient } from '../test/support.ts';
import { ConversationRequests } from '../src/request-log.ts';
import type { RequestBilling } from '../src/request-log-store.ts';

const minute = 60_000;
const day = 24 * 60 * minute;
const now = Date.now();
const date = new Date(now);
const thisMonth = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
const lastMonth = new Date(date.getFullYear(), date.getMonth() - 1, 1).getTime();
const origins = (process.env.DEMO_ORIGINS ?? 'http://localhost:5210,http://localhost:5211').split(',');
const claude = 'anthropic'; // The bundled list-price lookup uses the actual provider and plan IDs.
const ownerPlan = 'meadow-example';
const noLimit = 'orchard-example';
const apiKey = 'river-example';
const reset = new Date(now + 3 * day).toISOString();
const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
	const path = new URL(String(input)).pathname;
	if (path === '/api/oauth/profile') return Response.json({
		account: { email_address: 'demo@example.test', has_claude_max: true },
		organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x' },
	});
	if (path === '/api/oauth/usage') return Response.json({
		five_hour: { utilization: 12, resets_at: new Date(now + 45 * minute).toISOString() },
		seven_day: { utilization: 0, resets_at: reset },
		seven_day_sonnet: { utilization: 0, resets_at: reset },
	});
	return new Response(null, { status: 404 });
}) as typeof fetch;

const setup = await createSetup({
	allowedOrigins: origins,
	terminals: false,
	subscriptionUsage: { fetch: fakeFetch, anthropicBaseUrl: 'https://usage.example.test', pollIntervalMs: day },
	configureModels(models) {
		for (const [id, name] of [[claude, 'Claude'], [ownerPlan, 'Meadow AI'], [noLimit, 'Orchard Agent'], [apiKey, 'River API']] as const) {
			models.setProvider(createProvider({
				id, name, models: [],
				auth: id === claude ? { oauth: {
					name: 'Demo subscription', isSubscription: true,
					async login() { throw new Error('Demo does not log in'); },
					async refresh() { throw new Error('Demo does not refresh credentials'); },
					async toAuth() { return { apiKey: 'synthetic' }; },
				} } : {},
				api: lazyApi(async () => { throw new Error('Demo does not run models'); }),
			}));
		}
	},
});

let client: TestClient | undefined;
const shutdown = async () => { client?.close(); await setup.cleanup(); };
try {
	client = await TestClient.open(setup.server);
	await client.hello();
	const added = await client.request({ type: 'projects.add', path: setup.projectDir });
	if (added.type !== 'projects.add') throw new Error('Could not add demo project');
	const projectId = added.project.id;
	await client.request({ type: 'projects.configure', projectId, name: 'Example bakery', coordinatorModel: { provider: 'faux', modelId: 'faux-1' } });
	const { runtime } = await setup.server.manager.open(projectId);
	for (const [title, parent] of [['Publish the spring menu', null], ['Write the menu text', 'T1'], ['Photograph the pastries', 'T1'], ['Prepare the market stall', null], ['Print the price cards', 'T4']] as const) {
		await runtime.board.saveTask({ task: { title, parent, status: 'todo', description: 'Synthetic bakery work.', acceptance: null, blockedBy: [], blockedReason: null, writeScopes: [] } }, 'coordinator');
	}
	const store = setup.server.requestLog?.store;
	if (!store) throw new Error('Demo request log is unavailable');
	const { ledger } = store;

	for (const [provider, plan, billing] of [[claude, 'Max 5x', 'subscription'], [ownerPlan, 'Field', 'subscription'], [noLimit, null, 'agent']] as const) {
		store.subscriptionTerms.observe(provider, plan, billing, lastMonth);
	}
	store.subscriptionTerms.setPrice(ownerPlan, 35, lastMonth + minute);

	const request = (at: number, provider: string, model: string, cost: number, billing: RequestBilling | null, taskId: string | null, priced = true): void => {
		const conversation = new ConversationRequests({ projectId, conversationId: taskId ? Number(taskId.slice(1)) + 1 : 1,
			identity: { kind: taskId ? 'worker' : 'main', threadId: 'main', taskId, workerId: taskId ? `example-${taskId}` : null, scheduleId: null } });
		store.insert({ ...conversation.request({ provider, model, timestamp: at, usage: { input: 84_000, output: 7_000, cost: { total: cost } } },
			{ wake: 'user', retention: 'short', changes: null, source: 'live' }), billing, priced, durationMs: minute / 2 });
	};

	const read = (at: number, provider: string, id: string, usedPercent: number, resetsAt: number, scope?: string): void => {
		ledger.reading(provider, {
			id, label: scope ? `Weekly · ${scope}` : 'Weekly limit', usedPercent, resetsAt: new Date(resetsAt).toISOString(),
			windowMinutes: 7 * 24 * 60, source: 'usage_api', ...(scope ? { scope } : {}),
		}, at);
	};

	for (const [start, end, multiplier] of [[lastMonth, thisMonth, 0.55], [thisMonth, now, 1]] as const) {
		const sample = Math.max(1, Math.floor((end - start) / 12));
		const at = start + sample;
		const closesAt = at + 6 * sample;
		read(at, claude, 'seven_day', 2, closesAt);
		read(at, claude, 'seven_day_sonnet', 0, closesAt, 'sonnet');
		read(at, ownerPlan, 'weekly', 7, closesAt);
		request(at + sample, claude, 'demo-sonnet', 122, 'subscription', 'T2');
		request(at + sample, ownerPlan, 'demo-meadow-small', 78 * multiplier, 'subscription', 'T5');
		read(at + 2 * sample, claude, 'seven_day', 22, closesAt);
		read(at + 2 * sample, claude, 'seven_day_sonnet', 12, closesAt, 'sonnet');
		read(at + 2 * sample, ownerPlan, 'weekly', 9, closesAt);
		read(closesAt, claude, 'seven_day', 0, closesAt + day);
		read(closesAt, claude, 'seven_day_sonnet', 0, closesAt + day, 'sonnet');
		read(closesAt, ownerPlan, 'weekly', 0, closesAt + day);
		request(at + 8 * sample, claude, 'demo-sonnet', 818 * multiplier, 'subscription', 'T3');
		request(at + 8 * sample, claude, 'demo-opus', 550 * multiplier, 'subscription', 'T4');
		request(at + 8 * sample, claude, 'demo-opus', 150 * multiplier, 'subscription', null);
		request(at + 8 * sample, noLimit, 'demo-orchard', 56 * multiplier, 'agent', 'T1');
		request(at + 8 * sample, noLimit, 'demo-orchard-unpriced', 0, 'agent', 'T1', false);
		request(at + 8 * sample, apiKey, 'demo-river', 23.45 * multiplier, 'api_key', null);
		request(at + 8 * sample, claude, 'demo-opus', 0, null, null); // Legacy billing is assumed.
	}
	await setup.credentials.modify(claude, async () => ({ type: 'oauth', access: 'synthetic', refresh: 'synthetic', expires: now + day }));
	await client.request({ type: 'subscriptions.usage', refresh: true });
	const info = { url: setup.server.url, projectId, pid: process.pid };
	if (process.env.DEMO_OUTPUT) await Bun.write(process.env.DEMO_OUTPUT, JSON.stringify(info));
	console.log(`Subscription value demo ready at ${info.url}. Project: ${projectId}`);
} catch (error) {
	await shutdown();
	throw error;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => { void shutdown().finally(() => process.exit(0)); });
}
await new Promise(() => {});
