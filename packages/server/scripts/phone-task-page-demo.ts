/**
 * Synthetic backend for the phone task page (T475): one working task held by a named coordinator, with a two-line
 * title, a ticket and a branch as refs, a long summary and an HTML proof file. Run from the repository root with Bun.
 * DEMO_ORIGINS lists the web origins allowed to use it; reverse the printed port with adb for the emulator.
 */
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import type { RefStatus } from '@kemiri/protocol';
import { coordinatorWriter, openBoard, saveTask, writeReportIn } from '../src/board.ts';
import { createSetup, TestClient } from '../test/support.ts';

const setup = await createSetup({
	allowedOrigins: (process.env.DEMO_ORIGINS ?? 'http://localhost:5210').split(','),
	terminals: false,
});
setup.faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage('Synthetic demo ready.')));
// The ticket has a live state; the branch is a ref the backend cannot read, as on a real host.
setup.server.manager.refStatuses = async (_projectId, refs) => refs.filter(ref => ref === 'ORCH-258').map((ref): RefStatus => ({
	ref, kind: 'jira', url: 'https://tickets.example.test/browse/ORCH-258', title: 'Plan the orchard coordinator',
	status: 'In progress', category: 'in_progress', checkedAt: new Date().toISOString(),
}));
const client = await TestClient.open(setup.server);
await client.hello();
const added = await client.request({ type: 'projects.add', path: setup.projectDir });
if (added.type !== 'projects.add') throw new Error('Could not add the synthetic project');
const projectId = added.project.id;
const model = { provider: 'faux', modelId: 'faux-1' };
await client.request({ type: 'projects.configure', projectId, name: 'Orchard Planner', coordinatorModel: model, workerModels: [model] });
const { runtime } = await setup.server.manager.open(projectId);
const builder = await runtime.threads.create({ title: 'Orchard Builder Harness', area: 'The planner and its helpers.', color: '#5087dc' }, 'demo-builder');
await runtime.threads.create({ title: 'Market stall', area: 'The Saturday stall.', color: '#279c8e' }, 'demo-stall');

const taskId = await runtime.harness.commit(async tx => {
	const board = await openBoard(tx, runtime.conversation.id);
	return saveTask(board, { task: {
		title: 'Plan a coordinator with pickers for the orchard, modelled on Kemiri',
		description: 'Find out whether one planner with small helpers can replace the harvest checklist.',
		acceptance: null, status: 'in_progress', blockedBy: [], blockedReason: null, writeScopes: [],
		refs: ['ORCH-258', 'dev-pr3405'],
	}, ownerThreadId: builder.id, author: 'user', now: new Date().toISOString() }).after.id;
}, BACKGROUND_CONTEXT);

const pagePath = join(setup.projectDir, 'orchard-plan.html');
await Bun.write(pagePath, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>One planner. Small pickers.</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:40px 56px;color:#1a1830;background:#fbfaff}
small{letter-spacing:.08em;text-transform:uppercase;color:#6b6890}h1{font-size:40px;line-height:1.1;margin:.3em 0}
p{max-width:60ch}.chips span{display:inline-block;border:1px solid #cfcce6;border-radius:99px;padding:2px 10px;margin:4px 4px 0 0;font-size:12px}
section{margin-top:48px;border:1px solid #e3e1f2;border-radius:12px;padding:20px;background:#fff}</style>
<small>Plan · Orchard · analysis only, nothing changed</small>
<h1>One planner that plans. Small pickers that pick.</h1>
<p>Replace the checklist with a planner that cannot touch the trees and pickers that cannot talk to the grower.</p>
<div class="chips"><span>24 November 2026</span><span>read-only checks</span><span>no code or deploy</span></div>
<div class="chips"><span>1 Verdict</span><span>2 Kemiri</span><span>3 Design</span><span>4 Walk-through</span><span>5 Model setting</span><span>6 Build, risks, questions</span></div>
<section><small>Verdict</small><h2>Feasible and small: one new tool, one new model slot, the checklist deleted.</h2></section></html>`);
const page = await setup.server.artifacts.save({ projectId, sourcePath: pagePath, title: 'Orchard coordinator plan', note: 'The plan page.', threadId: builder.id, workerId: null, taskId });

await runtime.harness.commit(tx => writeReportIn(tx, runtime.conversation.id, {
	taskId, sections: {}, milestone: 'Plan ready', by: coordinatorWriter(builder.id),
	blocks: {
		summary: [{ kind: 'outcome', text: 'The change is feasible and small: one picker tool, one Coordinator model slot, and the checklist deleted. Sol 6.2 needs a catalogue row on dev-pr3405.' }],
		results: [
			{ kind: 'proof', text: 'The plan page walks through the verdict, the design and the build stages.', artifactRef: { artifactId: page.id.split('~')[0]!, version: page.version ?? 1 } },
			{ kind: 'finding', title: 'One planner is enough', text: 'The planner hands each row of trees to one picker and reads the baskets back.' },
			{ kind: 'finding', title: 'The checklist can go', text: 'Every line of the old checklist is covered by a picker brief.' },
			{ kind: 'risk', title: 'Catalogue row missing', text: 'Sol 6.2 is not in the catalogue on dev-pr3405 yet.' },
		],
		next: [{ kind: 'nextAction', text: 'The owner chooses the model for the planner.' }],
	},
}, `phone-task-page-demo:${taskId}`, new Date().toISOString(), { store: setup.server.artifacts, projectId }), BACKGROUND_CONTEXT);

const backends = [{ id: 'phone-task-demo', name: 'Phone task demo', url: setup.server.url }];
const route = `/b/phone-task-demo/projects/${encodeURIComponent(projectId)}?task=${encodeURIComponent(taskId)}`;
await Bun.write(process.env.DEMO_OUTPUT ?? '/tmp/phone-task-page-demo.json', JSON.stringify({ backends, route, url: setup.server.url, port: setup.server.port, projectId, taskId, pid: process.pid }));
console.log(`Phone task page demo ready: ${setup.server.url} ${route}`);
process.on('SIGTERM', async () => { client.close(); await setup.cleanup(); process.exit(0); });
await new Promise(() => {});
