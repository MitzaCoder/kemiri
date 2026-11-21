/** Seed two disposable Usage demo backends. No provider calls or persistent backend data. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createProvider } from '@earendil-works/pi-ai';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';
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
const apiKey = 'river-example';
const reset = new Date(now + 3 * day).toISOString();
const later = (ms: number) => new Date(now + ms).toISOString();
const fakeFetch = (async (input: Parameters<typeof fetch>[0]) => {
	const path = new URL(String(input)).pathname;
	if (path === '/api/oauth/profile') return Response.json({
		account: { email_address: 'demo@example.test', has_claude_max: true },
		organization: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x' },
	});
	if (path === '/api/oauth/usage') return Response.json({
		five_hour: { utilization: 67, resets_at: new Date(now + 45 * minute).toISOString() },
		seven_day: { utilization: 74, resets_at: reset },
		seven_day_sonnet: { utilization: 18, resets_at: reset },
	});
	if (path.endsWith('/wham/usage')) return Response.json({ plan_type: 'plus', rate_limit: {
		primary_window: { used_percent: 38, limit_window_seconds: 18000, reset_at: (now + 2 * 60 * minute) / 1000 },
		secondary_window: { used_percent: 24, limit_window_seconds: day * 7 / 1000, reset_at: (now + 4 * day) / 1000 },
	} });
	if (path === '/v1/usage') return Response.json({ plan: 'go', usage: {
		rolling: { percent: 14, resetsAt: later(3 * 60 * minute) },
		weekly: { percent: 22, resetsAt: later(5 * day) },
		monthly: { percent: 9, resetsAt: later(18 * day) },
	} });
	return new Response(null, { status: 404 });
}) as typeof fetch;

async function seedBackend(secondary: boolean) {
	const additionalProviders = secondary ? [['openai-codex', 'ChatGPT'], ['opencode-go', 'OpenCode Go']] as const : [['antigravity', 'Antigravity']] as const;
	let fixtureClock = now - 22 * minute;
	const setup = await createSetup({
		allowedOrigins: origins,
		now: () => fixtureClock,
		terminals: false,
		subscriptionUsage: {
			fetch: fakeFetch, anthropicBaseUrl: 'https://usage.example.test', chatgptBaseUrl: 'https://usage.example.test',
			opencodeGoBaseUrl: 'https://usage.example.test', pollIntervalMs: day,
			async readAntigravityQuota() { return { source: 'usage_api', plan: 'AI Pro', account: 'studio@example.test', windows: [
				{ id: 'gemini-pro', label: 'Gemini Pro', usedPercent: fixtureClock < now ? 70 : 96, windowMinutes: 300, resetsAt: later(38 * minute) },
				{ id: 'gemini-flash', label: 'Gemini Flash', usedPercent: fixtureClock < now ? 18 : 26, windowMinutes: 300, resetsAt: later(120 * minute) },
			] }; },
		},
		configureModels(models) {
			for (const [id, name] of [[claude, 'Claude'], [apiKey, 'River API'], ...additionalProviders] as const) {
				if (id === 'opencode-go') { models.setProvider(opencodeGoProvider()); continue; }
				models.setProvider(createProvider({
					id, name, models: [],
					auth: [claude, 'openai-codex', 'antigravity'].includes(id) ? { oauth: {
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
		await client.request({ type: 'projects.configure', projectId, name: secondary ? 'Example bookshop' : 'Example bakery', coordinatorModel: { provider: 'faux', modelId: 'faux-1' } });
		const cafeDir = join(setup.root, 'cafe');
		await mkdir(cafeDir);
		const cafe = await client.request({ type: 'projects.add', path: cafeDir });
		if (cafe.type !== 'projects.add') throw new Error('Could not add second demo project');
		const cafeProjectId = cafe.project.id;
		await client.request({ type: 'projects.configure', projectId: cafeProjectId, name: secondary ? 'Example greenhouse' : 'Example café', coordinatorModel: { provider: 'faux', modelId: 'faux-1' } });
		const { runtime } = await setup.server.manager.open(projectId);
		const café = await setup.server.manager.open(cafeProjectId);
		await café.runtime.board.saveTask({ task: { title: 'Plan the opening weekend', parent: null, status: 'todo', description: 'Synthetic work.', acceptance: null, blockedBy: [], blockedReason: null, writeScopes: [] } }, 'coordinator');
		const bakeryTasks = [['Publish the spring menu', null], ['Write the menu text', 'T1'], ['Photograph the pastries', 'T1'], ['Prepare the market stall', null], ['Print the price cards', 'T4']] as const;
		const bookshopTasks = [['Publish the reading list', null], ['Write the book notes', 'T1'], ['Photograph the new books', 'T1'], ['Prepare the launch table', null], ['Print the bookmarks', 'T4']] as const;
		for (const [title, parent] of secondary ? bookshopTasks : bakeryTasks) {
			await runtime.board.saveTask({ task: { title, parent, status: 'todo', description: 'Synthetic bakery work.', acceptance: null, blockedBy: [], blockedReason: null, writeScopes: [] } }, 'coordinator');
		}
		const store = setup.server.requestLog?.store;
		if (!store) throw new Error('Demo request log is unavailable');
		const { ledger } = store;

		store.subscriptionTerms.observe(claude, 'Max 5x', 'subscription', lastMonth);

		const request = (at: number, provider: string, model: string, cost: number, billing: RequestBilling | null, taskId: string | null, priced = true, requestProjectId = projectId): void => {
			const conversation = new ConversationRequests({ projectId: requestProjectId, conversationId: taskId ? Number(taskId.slice(1)) + 1 : 1,
				identity: { kind: taskId ? 'worker' : 'main', threadId: 'main', taskId, workerId: taskId ? `example-${taskId}` : null, scheduleId: null } });
			store.insert({ ...conversation.request({ provider, model, timestamp: at, usage: { input: 84_000, cacheRead: 1_140_000, output: 7_000, cost: { total: cost } } },
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
			request(at + sample, claude, 'demo-sonnet', 122, 'subscription', 'T2');
			read(at + 2 * sample, claude, 'seven_day', 22, closesAt);
			read(at + 2 * sample, claude, 'seven_day_sonnet', 12, closesAt, 'sonnet');
			read(closesAt, claude, 'seven_day', 0, closesAt + day);
			read(closesAt, claude, 'seven_day_sonnet', 0, closesAt + day, 'sonnet');
			request(at + 8 * sample, claude, 'demo-sonnet', 818 * multiplier, 'subscription', 'T3');
			request(at + 8 * sample, claude, 'demo-opus', 550 * multiplier, 'subscription', 'T4');
			request(at + 8 * sample, claude, 'demo-opus', 150 * multiplier, 'subscription', null);
			request(at + 8 * sample, claude, 'demo-sonnet', 42.5 * multiplier, 'subscription', null, true, cafeProjectId);
			request(at + 8 * sample, apiKey, 'demo-river', 23.45 * multiplier, 'api_key', null);
			request(at + 8 * sample, claude, 'demo-opus', 0, null, null); // Legacy billing is assumed.
		}
		const providers = [claude, ...additionalProviders.map(([provider]) => provider)];
		for (const [index, provider] of providers.entries()) {
			const billing = provider === 'opencode-go' ? 'plan_key' : 'subscription';
			await setup.credentials.modify(provider, async () => billing === 'plan_key'
				? { type: 'api_key', key: 'synthetic' } : { type: 'oauth', access: 'synthetic', refresh: 'synthetic', expires: now + day });
			for (let i = 1; i <= 6; i++) request(now - i * minute * 22, provider,
				provider === claude ? (i % 2 ? 'claude-sonnet' : 'claude-opus') : provider === 'openai-codex' ? 'gpt-5' : provider === 'antigravity' ? 'gemini-pro' : 'glm',
				(6 + i * 4) * (index + 1), billing, i > 4 ? null : i > 2 ? 'T1' : 'T2', true, i > 2 ? cafeProjectId : projectId);
		}
		if (!secondary) store.subscriptionTerms.setPrice('antigravity', 20, thisMonth);
		await client.request({ type: 'subscriptions.usage', refresh: true });
		fixtureClock = now;
		await client.request({ type: 'subscriptions.usage', refresh: true });
		const info = { url: setup.server.url, projectId, pid: process.pid };
		return { info, shutdown };
	} catch (error) {
		await shutdown();
		throw error;
	}
}

const studio = await seedBackend(false);
const workshop = await seedBackend(true).catch(async (error) => { await studio.shutdown(); throw error; });
const backends = [{ id: 'studio', name: 'Studio', url: studio.info.url }, { id: 'workshop', name: 'Workshop', url: workshop.info.url }];
if (process.env.DEMO_OUTPUT) await Bun.write(process.env.DEMO_OUTPUT, JSON.stringify({ ...studio.info, backends }));
console.log('Usage demo ready:', JSON.stringify(backends));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => { void Promise.all([studio.shutdown(), workshop.shutdown()]).finally(() => process.exit(0)); });
}
await new Promise(() => {});
