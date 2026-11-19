import { expect, it } from 'bun:test';
import type { BoardLiveLine } from '@kemiri/protocol';
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
 const lines = visibleLiveLines([a, line('future', 'fact'), line('b', 'result')]);
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
