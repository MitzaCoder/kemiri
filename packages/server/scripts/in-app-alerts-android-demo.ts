/** Two throwaway backends for Android banner proof. Reverse both ports and add them in Settings → Backends. */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { BoardDoc } from '../src/board.ts';
import { workerNotification } from '../src/notifications.ts';
import { createSetup, TestClient } from '../test/support.ts';

const fixtures: Awaited<ReturnType<typeof createSetup>>[] = [];
const clients: TestClient[] = [];
async function addProject(name: string) {
	const setup = await createSetup({ terminals: false });
	fixtures.push(setup);
	setup.faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage('The answer is recorded.')));
	const client = await TestClient.open(setup.server);
	clients.push(client);
	await client.hello();
	const response = await client.request({ type: 'projects.add', path: setup.projectDir, name });
	if (response.type !== 'projects.add') throw new Error('Could not add the synthetic project');
	const projectId = response.project.id;
	await client.request({ type: 'projects.configure', projectId, name, coordinatorModel: { provider: 'faux', modelId: 'faux-1' } });
	return { setup, projectId, name };
}

const bakery = await addProject('Bakery site');
const recipes = await addProject('Recipe API');
const { runtime } = await recipes.setup.server.manager.open(recipes.projectId);
let workerAttempt = 0;
const control = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
	const route = new URL(request.url).pathname;
	if (request.method === 'GET' && route === '/questions') return Response.json((await runtime.board.get()).questions);
	if (request.method !== 'POST') return new Response(null, { status: 405 });
	if (route === '/question') {
		const question = await runtime.harness.commit(async tx => {
			const doc = await tx.doc(BoardDoc, runtime.conversation.id);
			const id = `Q${++doc.counters.question}`;
			const question = { id, revision: 1, kind: 'question', text: 'Which units should the recipe import use?',
				options: ['Grams', 'Cups'], taskId: null, status: 'open', answer: null,
				askedAt: new Date().toISOString(), answeredAt: null, threadId: 'main' } as const;
			const entry = { ...question, options: [...question.options] };
			doc.questions.push(entry);
			return entry;
		}, BACKGROUND_CONTEXT);
		runtime.board.noticeQuestion(question);
		return Response.json({ id: question.id });
	}
	if (route === '/failure') {
		recipes.setup.server.notifications.notify(workerNotification({ projectId: recipes.projectId, projectName: recipes.name,
			workerId: 'recipe-import', callId: `${++workerAttempt}`, kind: 'worker_failed', text: null,
			failure: 'The import stopped before it could read the recipe notes.' }));
		return Response.json({ ok: true });
	}
	if (route === '/review') {
		await runtime.board.saveTask({ task: { title: 'Check the sample recipes', description: 'A synthetic review.',
			acceptance: null, status: 'review', blockedBy: [], blockedReason: null, writeScopes: [] } }, 'coordinator');
		return Response.json({ ok: true });
	}
	return new Response(null, { status: 404 });
} });

console.log(JSON.stringify({ pid: process.pid, bakery: bakery.setup.server.port, recipes: recipes.setup.server.port, control: control.port }));
process.on('SIGTERM', async () => {
	await control.stop(true);
	clients.forEach(client => client.close());
	await Promise.all(fixtures.map(fixture => fixture.cleanup()));
	process.exit(0);
});
