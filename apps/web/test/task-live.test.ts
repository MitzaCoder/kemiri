import { expect, it } from 'bun:test';
import { createServer } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoardLiveLine, BoardTaskActivity } from '@kemiri/protocol';
import { liveSeenKey, visibleLiveLines, visitLiveTrail } from '../src/lib/task-live.js';

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


it('renders the pulse and recorded facts with nonzero counters, without repeating Now', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'kemiri-live-test-'));
 const vite = await createServer({ root: import.meta.dir + '/..', cacheDir: join(directory, 'cache'), server: { middlewareMode: true }, logLevel: 'error' });
 try {
  const { default: TaskLive } = await vite.ssrLoadModule('/src/lib/components/TaskLive.svelte');
  const { render } = await vite.ssrLoadModule('svelte/server');
  const now: BoardTaskActivity = { actor: a.actor, kind: 'working', text: `fern is ${a.text}`, since: a.at, refs: [] };
  const fact = { ...b, kind: 'fact', text: 'Saved 9 files' };
  const counters = { steps: 2, filesSaved: 9, filesChanged: 0, commits: 0, checks: 0 };
  const props = { now, backendId: 'demo', projectId: 'bakery', taskId: 'T1' };
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
 } finally {
  await vite.close();
  await rm(directory, { recursive: true, force: true });
 }
});
