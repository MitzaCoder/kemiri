import { beforeAll, describe, expect, it } from 'bun:test';
import { loadSvelteSsr } from './svelte-ssr.js';
import type { BoardLiveLine, BoardTaskActivity, WorkerSummary } from '@kemiri/protocol';
import { liveNewsWorkLogHref, liveSeenKey, visibleLiveLines, visitLiveTrail } from '../src/lib/task-live.js';

const line = (id: string, kind = 'phase'): BoardLiveLine => ({ id, kind, at: new Date(Date.UTC(2026, 5, 1, 12, 0, id.charCodeAt(0))).toISOString(), text: 'Checking the page', actor: { id: 'a', kind: 'worker', name: 'fern', threadId: 'main', conversationId: 1, runId: 'one' } });
const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => line(id)) as [BoardLiveLine, BoardLiveLine, BoardLiveLine, BoardLiveLine];

it('saves the newest visible line without moving the divider until the next visit', () => {
 const saved = new Map<string, string>();
 const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, id: string) => { saved.set(key, id); } };
 const key = liveSeenKey('local', 'bakery', 'T1');
 const first = visitLiveTrail(storage, key);
 expect(first([a, b])).toEqual({ unseen: 0, arrived: [] });
 expect(first([a, b, c])).toEqual({ unseen: 1, arrived: ['c'] });
 expect(first([a, b, c])).toEqual({ unseen: 1, arrived: [] });
 expect(saved.get(key)).toBe(JSON.stringify({ id: c.id, at: c.at }));
 // A closed or hidden sheet does not advance the cursor; a new visible visit reopens it at c.
 expect(visitLiveTrail(storage, key)([a, b, c, d])).toEqual({ unseen: 1, arrived: [] });
 expect(visitLiveTrail(storage, key)([a, b, c, d])).toEqual({ unseen: 0, arrived: [] });
 expect(visitLiveTrail(storage, liveSeenKey('local', 'another', 'T1'))([a, b, c, d]).unseen).toBe(0);
});

it('ignores future kinds and treats a checkpoint outside the retained trail as older than all lines', () => {
 const storage = { getItem: () => JSON.stringify({ id: 'evicted', at: '2026-06-01T12:00:00.000Z' }), setItem: () => {} };
 const lines = visibleLiveLines([a, line('future', 'unrecognized'), line('b', 'result')]);
 expect(lines.map(line => line.id)).toEqual(['a', 'b']);
 expect(visitLiveTrail(storage, 'task')([]).unseen).toBe(0);
 expect(visitLiveTrail(storage, 'task')(lines)).toEqual({ unseen: 2, arrived: [] });
});

it('does not re-highlight earlier lines when a source folds, and marks the first line in an open empty trail', () => {
 const storage = { getItem: () => null, setItem: () => {} };
 const visit = visitLiveTrail(storage, 'task');
 expect(visit([])).toEqual({ unseen: 0, arrived: [] });
 expect(visit([a, b])).toEqual({ unseen: 2, arrived: ['a', 'b'] });
 expect(visit([a])).toEqual({ unseen: 1, arrived: [] });
 const reopened = visitLiveTrail({ ...storage, getItem: () => JSON.stringify({ id: b.id, at: b.at }) }, 'task');
 expect(reopened([a, c])).toEqual({ unseen: 1, arrived: [] });
});


describe('task live server rendering', () => {
 let ssr: typeof import('./fixtures/task-live-ssr.js');
 beforeAll(async () => {
  ssr = await loadSvelteSsr(import.meta.dir + '/fixtures/task-live-ssr.ts') as typeof ssr;
 });

 const now: BoardTaskActivity = { actor: a.actor, kind: 'working', text: `fern is ${a.text}`, since: a.at, refs: [] };
 const props = { now, backendId: 'demo', projectId: 'bakery', taskId: 'T1' };
 const fact = { ...b, kind: 'fact', text: 'Saved 9 files' };

 it('renders the pulse and recorded facts with nonzero counters, without repeating Now', () => {
  const { TaskLive, render } = ssr;
  const counters = { steps: 2, filesSaved: 9, filesChanged: 0, commits: 0, checks: 0 };
  const html = render(TaskLive, { props: { ...props, live: { lines: [a, fact], pulse: { tool: 'bash', label: 'Running tests', since: a.at }, counters } } }).body;
  expect(html).toContain('Running tests');
  expect(html).toContain('Recorded');
  expect(html).toContain('Saved 9 files');
  expect(html).toContain('2 steps');
  expect(html).toContain('9 files saved');
  expect(html).not.toMatch(/0 (steps|checks|commits|files)/);
  expect(html.match(/Checking the page/g)).toHaveLength(1);
  const empty = render(TaskLive, { props: { ...props, live: { lines: [], counters: { ...counters, steps: 0, filesSaved: 0 } } } }).body;
  expect(empty).not.toContain('Run counters');
  expect(empty).not.toContain('Run pulse');
  expect(empty).not.toContain('Plan steps');
 });

 it('renders plan progress above the live trail', () => {
  const { TaskLive, render } = ssr;
  const withPlan = render(TaskLive, { props: { ...props, live: { lines: [fact], plan: [
   { text: 'Trace payments', status: 'done' }, { text: 'Add gift cards', status: 'done' },
   { text: 'Check balances', status: 'done' }, { text: 'Run tests', status: 'doing' },
   { text: 'Save a receipt', status: 'todo' },
  ] } } }).body;
  expect(withPlan).toContain('3 of 5');
  expect(withPlan).toContain('aria-label="Plan steps"');
  expect(withPlan.match(/data-status="done"/g)).toHaveLength(3);
  expect(withPlan.match(/✓/g)).toHaveLength(3);
  expect(withPlan).toMatch(/<li data-status="doing" class="[^"]*\bcurrent-step\b/);
  expect(withPlan).toContain('data-status="todo"');
  expect(withPlan).toContain('Show steps');
  expect(withPlan.indexOf('Plan steps')).toBeLessThan(withPlan.indexOf('So far'));
 });

 it('renders automatic news with grouped evidence and work log links', () => {
  const { TaskLive, render } = ssr;
  const auto = { ...line('c', 'auto'), picker: 'most_steps', evidence: { conversationId: 1, steps: [
   ...[18, 20, 22, 24].map(id => ({ entryId: String(id), description: 'Editing a file · payments.ts' })),
   { entryId: '26', description: 'Running tests · checkout' }, { entryId: '28', description: 'Editing a file · payments.ts' },
  ] } };
  const worker = { id: 'fern', threadId: 'main', conversationId: 1 } as WorkerSummary;
  const news = { markWrong: async () => {}, workLogHref: (line: BoardLiveLine, entryId: string) => liveNewsWorkLogHref('demo', 'bakery', [worker], line, entryId) };
  const autoHtml = render(TaskLive, { props: { ...props, news, live: { lines: [auto] } } }).body;
  expect(autoHtml).toContain('data-kind="auto"');
  expect(autoHtml).toMatch(/live-line-kind[^>]*>auto</);
  expect(autoHtml).toContain('<details');
  expect(autoHtml).toContain('Recorded steps');
  expect(autoHtml).toContain('Editing a file · payments.ts');
  expect(autoHtml).toContain('Running tests · checkout');
  expect(autoHtml.match(/×4/g)).toHaveLength(1);
  expect(autoHtml).toContain('#entry-28');
  expect(autoHtml).not.toContain('#entry-20');
  expect(render(TaskLive, { props: { ...props, news: { ...news, workLogHref: () => undefined }, live: { lines: [auto] } } }).body).toContain('The work log is not available');
  expect(autoHtml).toContain('Open the work log here');
  expect(autoHtml).toContain('/workers/fern#entry-18');
  expect(autoHtml).toContain('This is wrong');
  expect(liveNewsWorkLogHref('demo', 'bakery', [{ ...worker, conversationId: 2 }], auto, '18')).toBeUndefined();
  const wrongHtml = render(TaskLive, { props: { ...props, news, live: { lines: [{ ...auto, wrong: { by: 'owner', at: auto.at } }] } } }).body;
  expect(wrongHtml).toContain('Marked wrong');
  expect(wrongHtml).not.toContain('This is wrong');
  expect(render(TaskLive, { props: { ...props, live: { lines: [auto] } } }).body).not.toContain('data-kind="auto"');
 });

 it('renders live news settings only when the backend supports them', () => {
  const { ReportAuditGroup, render } = ssr;
  const setting = (features: string[], mode: 'auto' | 'model') => render(ReportAuditGroup, { props: { watcher: true, projectId: 'bakery', backend: {
   supports: (feature: string) => features.includes(feature), projects: [{ id: 'bakery', taskWatcher: { mode, dailyTokens: 1000 } }],
   connection: { features }, models: [], providers: [], modelsLoaded: true,
  } } }).body;
  expect(setting(['task-live'], 'auto')).not.toContain('Live news lines');
  expect(setting(['task-live', 'task-live-watcher'], 'auto')).toContain('Uses recorded steps without a model');
  const chooseModel = setting(['task-live', 'task-live-watcher'], 'model');
  expect(chooseModel).toContain('Live news lines');
  expect(chooseModel).toContain('Live news model');
  expect(chooseModel).toContain('task-watcher-budget');
 });
});
