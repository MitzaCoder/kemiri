/** Synthetic web proof for agent apps. The example address is display-only; the fixture listens on loopback. */
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { join } from 'node:path';
import { createSetup, errorOf, TestClient, ViewClient } from '../test/support.ts';
import { DEFAULT_TAILSCALE_SERVE_RANGE, type AppAddresses } from '@kemiri/protocol';
import { fakeTailscale } from '../test/fake-tailscale.ts';
import { serveWeb } from '../src/static-web.ts';

const beforeDirectory = process.env.DEMO_BEFORE_WEB;
const afterDirectory = process.env.DEMO_WEB;
const web = (directory: string | undefined) => directory ? Bun.serve({
	hostname: '127.0.0.1', port: 0, fetch: request => new URL(request.url).pathname === '/aiki-local.json' ? new Response(null, { status: 404 }) : serveWeb(request, directory),
}) : undefined;
const before = web(beforeDirectory);
const after = web(afterDirectory);
const origins = [before?.url.origin, after?.url.origin, ...(process.env.DEMO_ORIGINS ?? '').split(',').filter(Boolean)]
	.filter((origin): origin is string => origin !== undefined);
const appAddresses: AppAddresses = process.env.DEMO_APP_ADDRESSES === 'tailscale-serve'
	? { mode: 'tailscale-serve', ...DEFAULT_TAILSCALE_SERVE_RANGE }
	: { mode: 'template', template: 'http://oven.example.test:{port}' };
const setup = await createSetup({ allowedOrigins: origins, terminals: false, log: console.log, appTailscale: fakeTailscale().tailscale });
const listener = Bun.serve({
	hostname: '127.0.0.1', port: 0,
	fetch: () => new Response('<h1>Bakery order form</h1><p>Sample orders only.</p>', { headers: { 'content-type': 'text/html' } }),
});
const client = await TestClient.open(setup.server);
await client.hello();
const added = await client.request({ type: 'projects.add', path: setup.projectDir });
if (added.type !== 'projects.add') throw errorOf(added);
const projectId = added.project.id;
await client.request({ type: 'projects.configure', projectId, name: 'Bakery orders', coordinatorModel: { provider: 'faux', modelId: 'faux-1' } });
const view = new ViewClient(client);
await view.start(projectId);
const { runtime } = await setup.server.manager.open(projectId);
const task = await runtime.board.saveTask({ task: {
	title: 'Redesign the order form', description: 'An invented bakery task.', acceptance: null, status: 'in_progress',
	blockedBy: [], blockedReason: null, writeScopes: [],
} }, 'coordinator');
const sampleFile = join(setup.projectDir, 'bakery-order-notes.txt');
await Bun.write(sampleFile, 'Sample order: one rye loaf.');
await setup.server.artifacts.save({ projectId, sourcePath: sampleFile, taskId: task.id, threadId: 'main', workerId: null });
await client.request({ type: 'apps.settings.set', settings: { addresses: appAddresses, policy: 'on' } });
setup.faux.setResponses(Array.from({ length: 40 }, () => request => {
	const last = request.messages.findLast(message => message.role !== 'system');
	const content = last?.content;
	const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.type === 'text' ? part.text : '').join('') : '';
	if (last?.role === 'user' && text.includes('Publish')) {
		return fauxAssistantMessage([fauxToolCall('app_publish', {
			name: text.includes('API docs') ? 'Orders API docs' : text.includes('receipt preview') ? 'Receipt preview' : 'Order form preview',
			port: listener.port!, taskId: task.id, ...(text.includes('API docs') ? { path: '/docs' } : {}),
		})], { stopReason: 'toolUse' });
	}
	return fauxAssistantMessage('The bakery preview is recorded on the task.');
}));
const seeded = await client.request({ type: 'conversation.submit', projectId, requestId: 'bakery-app-demo', content: 'Publish the order form preview.' });
if (seeded.type !== 'conversation.submit') throw errorOf(seeded);
const apps = setup.server.manager.apps!;
const deadline = Date.now() + 10_000;
while (!(await apps.list(projectId)).length) {
	if (Date.now() > deadline) throw new Error(`The demo agent did not publish. ${JSON.stringify(view.view?.entries.slice(-4))}`);
	await Bun.sleep(25);
}
// Separate children run inside the synthetic project, so the real listener scan can attribute their cwd.
async function projectListener() {
	const child = Bun.spawn([process.execPath, '-e', `
		const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('Bakery demo') });
		console.log(server.port);
	`], { cwd: setup.projectDir, stdout: 'pipe', stderr: 'inherit' });
	const reader = child.stdout.getReader();
	const { value } = await reader.read();
	reader.releaseLock();
	const port = Number(new TextDecoder().decode(value).trim());
	if (!port) throw new Error('The fixture did not start its project listener.');
	return { child, port };
}
const receipt = await projectListener();
const detected = await projectListener();
await apps.publish(projectId, { name: 'Receipt printer test page', port: receipt.port }, { publisher: {
	kind: 'coordinator', id: 'main', threadId: 'main', conversationId: runtime.conversation.id,
} }, runtime.activeApps);
receipt.child.kill();
await receipt.child.exited;
await client.request({ type: 'apps.settings.set', settings: { addresses: appAddresses, policy: process.env.DEMO_APP_RECORD ? 'on' : 'ask' } });
// For the recording, stop the order form process without using the app's Stop button.
process.on('SIGUSR2', () => { listener.stop(true); });
const fixture = { url: setup.server.url, projectId, taskId: task.id, port: listener.port, detectedPort: detected.port,
	before: before?.url.origin, after: after?.url.origin, pid: process.pid };
await Bun.write(process.env.DEMO_OUTPUT ?? '/tmp/apps-web-demo.json', JSON.stringify(fixture));
console.log('Synthetic Bakery orders backend ready.');
process.on('SIGTERM', async () => {
	client.close(); listener.stop(true); detected.child.kill(); await detected.child.exited;
	before?.stop(true); after?.stop(true); await setup.cleanup(); process.exit(0);
});
await new Promise(() => {});
