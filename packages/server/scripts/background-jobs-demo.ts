/** Reusable synthetic background-jobs backend. Run with Bun from the repository root. Never opens installed data. */
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createSetup, TestClient } from '../test/support.ts';
import { ThreadsDoc } from '../src/threads.ts';
import { WorkersDoc, type WorkerRecord } from '../src/workers.ts';

const origin = process.env.JOBS_WEB_ORIGIN ?? 'http://localhost:5173';
const output = process.env.JOBS_DEMO_OUTPUT ?? '/tmp/background-jobs-demo.json';
const test = await createSetup({ allowedOrigins: process.env.JOBS_WEB_ORIGINS?.split(',') ?? [origin], terminals: false });
console.log(JSON.stringify({ dataDir: test.dataDir, pid: process.pid }));

const textOf = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p?.type === 'text' ? p.text ?? '' : '').join('') : '';
const call = (name: string, args: object) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: 'toolUse' });
const hold = (signal?: AbortSignal) => new Promise<void>(r => signal?.addEventListener('abort', () => r(), { once: true }));

const jobs: Record<string, { title: string; brief: string }> = {
	'Rework the plant catalogue. It is a big job.': { title: 'Catalogue rework', brief: 'Rework the plant catalogue: new categories, photos and care notes for all 240 plants.' },
	'Also audit the photo library.': { title: 'Photo library audit', brief: 'Audit the photo library: find duplicates and oversized files.' },
	'Move the labels to the new printer format.': { title: 'Label printer migration', brief: 'Convert every label template to the new printer format.' },
	'Write the spring newsletter.': { title: 'Spring newsletter', brief: 'Draft the spring newsletter from this month\'s notes.' },
	'Prepare the care guide.': { title: 'Care guide', brief: 'Prepare a care guide.' },
	'Import the old price list.': { title: 'Old price import', brief: 'Import the 2019 price list into the catalogue.' },
};
let pendingJob: { title: string; brief: string } | undefined;

const factory = async (request: any, options?: { signal?: AbortSignal }) => {
	const system = request.messages.filter((m: any) => m.role === 'system').map((m: any) => m.sections ? Object.values(m.sections).join('\n') : textOf(m.content)).join('\n');
	const thread = /You are the background thread "([^"]+)"/.exec(system)?.[1];
	const last = request.messages.findLast((m: any) => m.role !== 'system');
	const text = textOf(last?.content); const tool = last?.role === 'toolResult' ? last.toolName : undefined;
	if (thread === undefined) {
		if (jobs[text]) { pendingJob = jobs[text]; return call('board', { action: 'add_task', title: pendingJob.title }); }
		const added = tool === 'board' ? /^Added (T\d+) /.exec(text) : null;
		if (added && pendingJob) return call('thread_start', { ...pendingJob, taskId: added[1] });
		if (tool === 'thread_start') return fauxAssistantMessage(`That is a big one, so I started **${pendingJob?.title}** in the background. It works in its own copy of the project and reports back here when it is done. You can keep talking to me meanwhile.`);
		if (text.startsWith('[thread spring-newsletter finished]')) return fauxAssistantMessage('The newsletter draft is ready: three stories and the opening-hours box. I checked it against the notes and it reads well. Want me to send it to the printer?');
		if (text.startsWith('[thread ')) return fauxAssistantMessage('Noted.');
		if (text.startsWith('How is the catalogue')) return call('thread_peek', { id: 'catalogue-rework' });
		if (tool === 'thread_peek') return fauxAssistantMessage('The catalogue rework is about a third through: categories are done, two workers are on photos and care notes.');
		return fauxAssistantMessage('Noted.');
	}
	if (thread === 'catalogue-rework') { if (tool === undefined && !text.startsWith('[')) { return call('bash', { command: 'sleep 100000' }); } await hold(options?.signal); return fauxAssistantMessage('Stopped.'); }
	if (thread === 'photo-library-audit') {
		if (tool === 'board') return fauxAssistantMessage('I found 310 duplicate photos. I asked which copies to keep and will wait for the answer.');
		if (text.startsWith('Audit')) return call('board', { action: 'ask', text: 'I found 310 duplicate photos. Keep the originals or only the resized copies?', options: ['Keep originals', 'Keep resized copies'] });
		return fauxAssistantMessage('Waiting.');
	}
	if (thread === 'label-printer-migration') return fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'The model provider returned 529: overloaded.' });
	if (thread === 'spring-newsletter' || thread === 'nightly-tidy-up') {
		if (tool === 'thread_finish') return fauxAssistantMessage('Done.');
		return call('thread_finish', { summary: thread === 'spring-newsletter' ? 'Newsletter drafted: three stories and the opening-hours box. Saved as newsletter-spring.md.' : 'Tidied 14 stale notes and re-sorted the seed inventory. Nothing needs you.' });
	}
	if (thread === 'old-price-import') { await hold(options?.signal); return fauxAssistantMessage('Stopped.'); }
	return fauxAssistantMessage('Nothing to do.');
};
test.faux.setResponses(Array.from({ length: 400 }, () => factory));

const client = await TestClient.open(test.server); await client.hello();
const added = await client.request({ type: 'projects.add', path: test.projectDir });
if (added.type !== 'projects.add') throw new Error(JSON.stringify(added));
const projectId = added.project.id;
const FAUX = { provider: 'faux', modelId: 'faux-1' };
await client.request({ type: 'projects.configure', projectId, name: 'Little things studio', coordinatorModel: FAUX, workerModels: [FAUX] });
const list = async () => { const r = await client.request({ type: 'threads.list', projectId, includeArchived: true }); return r.type === 'threads.list' ? r.threads : []; };
const until = async (ok: () => Promise<boolean>) => { for (let i = 0; i < 1200; i++) { if (await ok()) return; await Bun.sleep(25); } throw new Error('timeout'); };
const status = async (id: string) => (await list()).find(t => t.id === id)?.status;
const say = async (content: string) => { const r = await client.request({ type: 'conversation.submit', projectId, requestId: crypto.randomUUID(), content }); if (r.type !== 'conversation.submit') throw new Error(JSON.stringify(r)); };

await say('Rework the plant catalogue. It is a big job.'); await until(async () => (await status('catalogue-rework')) === 'running'); await Bun.sleep(600);
await say('Also audit the photo library.'); await until(async () => (await status('photo-library-audit')) === 'idle'); await Bun.sleep(600);
await say('Move the labels to the new printer format.'); await until(async () => (await status('label-printer-migration')) === 'failed'); await Bun.sleep(600);
await say('Write the spring newsletter.'); await until(async () => (await status('spring-newsletter')) === 'done'); await Bun.sleep(1200);
await say('Import the old price list.'); await until(async () => (await status('old-price-import')) === 'running'); await Bun.sleep(600);
const stopped = await client.request({ type: 'threads.stop', projectId, threadId: 'old-price-import' } as never); console.log('stop', (stopped as any).type);
const { runtime } = await test.server.manager.open(projectId);
const tidy = await runtime.board.saveTask({task:{title:'Nightly tidy-up',description:'',acceptance:null,status:'todo',blockedBy:[],blockedReason:null,writeScopes:[]}} as never,'coordinator');
const sched = await runtime.threads.start({ id: 'nightly-tidy-up', title: 'Nightly tidy-up', brief: 'Tidy stale notes.', model: null, thinkingLevel: null, onFinish: 'record', startedBy: 'schedule', scheduleId: null, taskId: tidy.id, key: 'seed-nightly' } as never);
if (!sched.ok) throw new Error(sched.message);
await until(async () => (await status('nightly-tidy-up')) === 'done');
await say('Prepare the care guide.'); await until(async () => (await status('care-guide')) === 'idle');
await say('How is the catalogue going?'); await Bun.sleep(1500);
// Two running workers on the catalogue thread, so the list shows them.
const cat = (await list()).find(t => t.id === 'catalogue-rework')!;
const w = (id: string, title: string): WorkerRecord => ({ id, title, conversationId: cat.conversationId as never, anchorTaskId: 0, isolation: 'shared', workspacePath: null, model: FAUX, thinkingLevel: null, status: 'running', taskId: 'T1', spawnedByCallId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastReport: null, failure: null } as never);
await runtime.harness.commit(async tx => { const doc = await tx.doc(WorkersDoc, cat.conversationId as never); doc.workers['photos'] = w('photos', 'Sort the plant photos'); doc.workers['notes'] = w('notes', 'Write care notes'); }, BACKGROUND_CONTEXT);
await runtime.harness.commit(async tx => { const doc = await tx.doc(ThreadsDoc, runtime.conversation.id); const job = doc.threads['nightly-tidy-up']!; job.finishedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); job.updatedAt = job.finishedAt; }, BACKGROUND_CONTEXT);
console.log(JSON.stringify((await list()).map(t => [t.id, t.status, t.runningWorkers, t.openQuestions, t.current])));
const connection = { url: test.server.url, projectId, pid: process.pid, origin };
await Bun.write(output, JSON.stringify(connection));
console.log(JSON.stringify(connection));
console.log('ready');
process.on('SIGTERM', async () => { client.close(); await test.cleanup(); process.exit(0); });
await new Promise(() => {});
