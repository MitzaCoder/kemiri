/** Synthetic, isolated real-backend fixture for the Android Ask back walkthrough. */
import { BACKGROUND_CONTEXT } from '../../../packages/server/node_modules/@earendil-works/chord/dist/context/index.js';
import { fauxAssistantMessage } from '../../../packages/server/node_modules/@earendil-works/pi-ai/dist/providers/faux.js';
import { createSetup, TestClient } from '../../../packages/server/test/support.ts';
import { askQuestion, coordinatorWriter, endQuestionClarification, replyQuestion } from '../../../packages/server/src/board.ts';

const setup = await createSetup({ terminals: false });
setup.faux.setResponses(Array.from({ length: 40 }, () => async (_request: unknown, options?: { signal?: AbortSignal }) => {
    await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
    return fauxAssistantMessage('Synthetic session ended.');
}));
const client = await TestClient.open(setup.server);
await client.hello();
const added = await client.request({ type: 'projects.add', path: setup.projectDir });
if (added.type !== 'projects.add') throw new Error('Could not add demo project');
const projectId = added.project.id;
await client.request({ type: 'projects.configure', projectId, name: 'Garden export', coordinatorModel: { provider: 'faux', modelId: 'faux-1' } });
const { runtime } = await setup.server.manager.open(projectId);
await runtime.board.saveTask({ task: { title: 'Export the seed inventory', description: 'A synthetic garden project.', acceptance: null, status: 'in_progress', blockedBy: [], blockedReason: null, writeScopes: [] } }, 'coordinator');
const by = coordinatorWriter('main');
await runtime.board.commitFor(change => runtime.harness.commit(change, BACKGROUND_CONTEXT), (state, now) => askQuestion(state, { text: 'Should the CSV include archived seeds?', options: ['Include archived', 'Active only'], taskId: 'T1', threadId: 'main', now }), by);
// Controls mutate only this fixture's board, through the same state functions as board tools.
const controls = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const action = new URL(request.url).pathname;
    if (action === '/reply' || action === '/no-reply') {
        await runtime.board.commitFor(change => runtime.harness.commit(change, BACKGROUND_CONTEXT), (state, now) => {
            const question = state.questions[0]!;
            if (action === '/reply') return replyQuestion(state, { questionId: question.id, expectedRevision: question.revision, text: 'There are 240 archived rows. Including them has no noticeable cost.', revisedText: 'Include the 240 archived seed rows in the CSV?', revisedOptions: ['Include all rows', 'Active only'], by, now });
            return endQuestionClarification(state, { questionId: question.id, expectedRevision: question.revision, now, failed: true });
        }, by);
    }
    return Response.json({ board: await runtime.board.state() });
} });
await Bun.write(process.env.DEMO_OUTPUT ?? '/tmp/android-clarify-demo.json', JSON.stringify({ url: setup.server.url, controls: controls.url.toString(), projectId, pid: process.pid }));
console.log('Isolated Android question demo ready.');
process.on('SIGTERM', async () => { controls.stop(); client.close(); await setup.cleanup(); process.exit(0); });
await new Promise(() => {});
