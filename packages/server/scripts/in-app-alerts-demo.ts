/** Two isolated demo backends for web pop-ups. POST /<backend id>/<question|failure|review> to the loopback control URL. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createSetup, TestClient } from '../test/support.ts';

const allowedOrigins = (process.env.DEMO_ORIGINS ?? 'http://localhost:5173').split(',');
const output = process.env.DEMO_OUTPUT ?? '/tmp/in-app-alerts-demo.json';
const model = { provider: 'faux', modelId: 'faux-1' };
const demoQuestions = [
	{ text: 'Which units should the spring recipes use?', choices: [{ label: 'Grams', recommended: true }, { label: 'Cups' }] },
	{ text: 'What batch size should the recipe import use?', choices: [{ label: 'Single batch', recommended: true }, { label: 'Double batch' }] },
];
const tool = (name: string, input: Record<string, unknown>) =>
	fauxAssistantMessage([fauxToolCall(name, input as never)], { stopReason: 'toolUse' });

async function startBackend(id: string, name: string, projectNames: string[]) {
	const setup = await createSetup({ terminals: false, allowedOrigins, log: message => console.log(`[${id}] ${message}`) });
	const client = await TestClient.open(setup.server);
	await client.request({ type: 'hello', protocolVersion: 1, client: { name: 'alert demo', features: ['in-app-alerts'] } });
	const projects: { id: string; name: string }[] = [];
	for (const [index, name] of projectNames.entries()) {
		const path = join(setup.root, `demo-project-${index}`);
		await mkdir(path);
		const added = await client.request({ type: 'projects.add', path });
		if (added.type !== 'projects.add') throw new Error(JSON.stringify(added));
		const configured = await client.request({ type: 'projects.configure', projectId: added.project.id, name, coordinatorModel: model, workerModels: [model] });
		if (configured.type !== 'projects.configure') throw new Error(JSON.stringify(configured));
		projects.push({ id: added.project.id, name });
	}
	let questionNumber = 0;
	setup.faux.setResponses(Array.from({ length: 500 }, () => request => {
		const last = request.messages.findLast(message => message.role !== 'system');
		const text = JSON.stringify(last?.content ?? '');
		if (last?.role === 'toolResult') return fauxAssistantMessage('Noted.');
		if (text.startsWith('"Demo question"') || text.includes('"text":"Demo question"')) {
			const question = demoQuestions[questionNumber++ % demoQuestions.length]!;
			return tool('board', { action: 'ask', ...question });
		}
		if (text.includes('Demo worker assignment')) return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'The recipe import stopped at the header.' });
		if (text.includes('Demo failure')) return tool('worker_spawn', { id: `recipe-import-${workerNumber++}`, task: 'Demo worker assignment' });
		const review = text.match(/Demo review (T\d+) revision (\d+)/);
		if (review) return tool('board', { action: 'update_task', id: review[1], expectedRevision: Number(review[2]), status: 'review' });
		return fauxAssistantMessage('The spring menu draft is ready.');
	}));
	return { setup, client, projects, config: { id, name, url: setup.server.url } };
}

let workerNumber = 1;
const first = await startBackend('demo-studio', 'Studio', ['Bakery site', 'Garden log']);
const second = await startBackend('demo-workshop', 'Workshop', ['Recipe API']);
const backends = [first, second];
const kinds = { question: 'board_question', failure: 'worker_failed', review: 'task_review' } as const;
let turn = 0;
const control = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
	const [, backendId, trigger] = new URL(request.url).pathname.split('/');
	const backend = backends.find(item => item.config.id === backendId);
	if (request.method !== 'POST' || !backend || (trigger !== 'question' && trigger !== 'failure' && trigger !== 'review')) {
		return new Response('POST /<backend id>/<question|failure|review>', { status: 404 });
	}
	const project = backend.projects.at(-1)!;
	try {
		let content = trigger === 'question' ? 'Demo question' : 'Demo failure';
		if (trigger === 'review') {
			const { runtime } = await backend.setup.server.manager.open(project.id);
			const task = await runtime.board.saveTask({ task: { title: 'Check the spring menu', description: 'Review the updated recipes.',
				status: 'in_progress', acceptance: null, blockedBy: [], blockedReason: null, parent: null, writeScopes: [] } }, 'coordinator');
			content = `Demo review ${task.id} revision ${task.revision}`;
		}
		const start = backend.client.messages.length;
		const submitted = await backend.client.request({ type: 'conversation.submit', projectId: project.id, requestId: `demo-alert-${++turn}`, content });
		if (submitted.type !== 'conversation.submit') throw new Error(JSON.stringify(submitted));
		const event = await backend.client.waitFor(message => message.type === 'notifications.alert' && message.alert.projectId === project.id &&
			message.alert.kind === kinds[trigger] && backend.client.messages.indexOf(message) >= start, 8_000);
		return Response.json(event);
	} catch (error) {
		return new Response(String(error), { status: 500 });
	}
} });

await Bun.write(output, JSON.stringify({
	backends: backends.map(backend => backend.config), control: control.url.origin, pid: process.pid,
	chat: `/b/${first.config.id}/projects/${first.projects[0]!.id}`,
}));
console.log('Synthetic alert backends ready.');
process.on('SIGTERM', async () => {
	control.stop(true);
	for (const backend of backends) backend.client.close();
	await Promise.all(backends.map(backend => backend.setup.cleanup()));
	process.exit(0);
});
await new Promise(() => {});
