/** Synthetic Answers proof. For before proof, run the same script on a server without the answers feature. */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { HARNESS_FEATURES } from '@kemiri/protocol';
import { createSetup, errorOf, TestClient } from '../test/support.ts';

const origins = (process.env.DEMO_ORIGINS ?? 'http://localhost:5210').split(',');
const output = process.env.DEMO_OUTPUT ?? '/tmp/answers-demo.json';
const today = new Date();
const dateAt = (daysAgo: number, hour: number, minute: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, hour, minute).getTime();
let clock = dateAt(5, 10, 15);
const setup = await createSetup({ allowedOrigins: origins, terminals: false, now: () => clock, boardEditDebounceMs: 3_600_000,
	features: HARNESS_FEATURES.filter(feature => feature !== 'answers' || process.env.DEMO_WITHOUT_ANSWERS !== '1') });
const client = await TestClient.open(setup.server);
await client.hello();
const added = await client.request({ type: 'projects.add', path: setup.projectDir });
if (added.type !== 'projects.add') throw errorOf(added);
const projectId = added.project.id;
const request = (type: string, body = {}) => client.request({ type, projectId, ...body });
const configured = await request('projects.configure', { name: 'Little bakery', coordinatorModel: { provider: 'faux', modelId: 'faux-1' } });
if (configured.type !== 'projects.configure') throw errorOf(configured);
const { runtime } = await setup.server.manager.open(projectId);
const answers = runtime.board.answers;
const idle = () => runtime.conversation.waitForIdle(BACKGROUND_CONTEXT);
let sequence = 0;
async function reply(question: string, answer: string, taskId?: string) {
	setup.faux.setResponses([fauxAssistantMessage(answer)]);
	const sent = await request('conversation.submit', { content: question, requestId: `demo-${++sequence}`, taskId });
	if (sent.type !== 'conversation.submit') throw errorOf(sent);
	await idle();
}

const task = await runtime.board.saveTask({ task: { title: 'Keep the recipe archive below its storage limit', description: 'Review what uses space and keep enough room for the next release.', acceptance: null, status: 'done', blockedBy: [], blockedReason: null, writeScopes: [], parent: null } }, 'user');
await reply('How does a friend install the app?', 'Share the release link. They can open it in their browser and choose **Install app** from the menu.');
if (answers) await answers.update('A1', { pinned: true, read: true });
clock = dateAt(1, 11, 2);
await reply('Is the menu preview live?', 'Yes. The preview has been live since 11:20, with the new spring items.');
if (answers) await answers.update('A2', { read: true });
clock = dateAt(0, 7, 31);
await reply('How much room is left in the recipe archive?', 'There were 12 GB free when I checked. The largest folders were last season’s photos and the print previews.', task.id);
if (answers) {
	clock = dateAt(0, 9, 12);
	setup.faux.setResponses([fauxAssistantMessage('The archive has **24 GB free** after the preview cleanup.\n\nThe recipe photos and print exports are still there. No recipe files were changed.')]);
	const asked = await request('answers.ask', { answerId: 'A3', requestId: 'demo-ask-again' });
	if (asked.type !== 'answers.ask') throw errorOf(asked);
	await idle();
	await answers.update('A3', { read: true });
} else {
	await reply('How much room is left in the recipe archive?', 'The archive has **24 GB free** after the preview cleanup.\n\nThe recipe photos and print exports are still there. No recipe files were changed.');
}
clock = dateAt(0, 11, 20);
await reply('What did the menu look like before the redesign?', 'It was one page with three tabs. We kept the older pictures in the release notes.');
setup.faux.setResponses([fauxAssistantMessage('Archived previews can be removed safely. The linked recipe photos are stored separately.')]);
if (answers) {
	// Recorded replies use the transcript's real clock. Date only the synthetic snapshots for the catalogue demo.
	const { AnswersDoc } = await import('../src/answers.ts');
	const dates = new Map([['A1', dateAt(5, 10, 15)], ['A2', dateAt(1, 11, 2)], ['A3', dateAt(0, 1, 12)], ['A4', dateAt(0, 1, 40)]]);
	await runtime.harness.commit(async tx => {
		const doc = await tx.doc(AnswersDoc, runtime.conversation.id);
		for (const [id, at] of dates) doc.answers![id]!.at = new Date(at).toISOString();
		doc.answers!.A3!.exchanges![0]!.at = new Date(dateAt(0, 0, 31)).toISOString();
	}, BACKGROUND_CONTEXT);
}
clock = Date.now();
await Bun.write(output, JSON.stringify({ url: setup.server.url, projectId, pid: process.pid }));
console.log('Synthetic Answers backend ready.');
process.on('SIGTERM', async () => { client.close(); await setup.cleanup(); process.exit(0); });
await new Promise(() => {});
