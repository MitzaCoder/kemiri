import { describe, expect, test } from 'bun:test';
import type { BoardTaskActivity, ThreadSummary, WorkerSummary } from '@kemiri/protocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { workerDoingNow, workerRunsIn, workerTranscriptThread } from '../src/lib/worker-peek.js';

const worker: WorkerSummary = {
	id: 'photo', title: 'Photograph the pastries', status: 'running',
	model: { provider: 'example', modelId: 'faux' }, thinkingLevel: null,
	isolation: 'shared', workspacePath: null, conversationId: 12, threadId: 'main', taskId: 'T3',
	spawnedByCallId: null, createdAt: '2026-01-01T12:00:00Z', updatedAt: '2026-01-01T12:30:00Z',
	lastReport: 'Shot the croissants; tarts next.', failure: null,
};
const activity: BoardTaskActivity = {
	kind: 'working', text: 'photo is photographing the tarts', since: worker.updatedAt, refs: [],
	actor: { id: 'synthetic-run', kind: 'worker', name: 'photo', threadId: 'main', conversationId: 12, runId: 'run-1' },
};
const task = { id: 'T3', title: worker.title, status: 'in_progress', activity };

describe('workerDoingNow', () => {
	test('uses the assigned task activity only for the same worker conversation and thread', () => {
		expect(workerDoingNow(worker, task, true)).toEqual({ source: 'activity', text: activity.text, activity });
		expect(workerDoingNow({ ...worker, threadId: undefined }, task, true)?.source).toBe('activity');
		const background = { ...worker, threadId: 'bakery' };
		const backgroundActivity = { ...activity, actor: { ...activity.actor!, threadId: 'bakery' } };
		expect(workerDoingNow(background, { ...task, activity: backgroundActivity }, true)?.source).toBe('activity');
	});
	test('falls back to the report for a different name, conversation, thread, actor kind or task', () => {
		for (const actor of [
			{ ...activity.actor!, name: 'sign' }, { ...activity.actor!, conversationId: 13 },
			{ ...activity.actor!, threadId: 'other-job' }, { ...activity.actor!, kind: 'thread' as const },
			{ ...activity.actor!, kind: 'coordinator' as const }, undefined,
		]) expect(workerDoingNow(worker, { ...task, activity: { ...activity, actor } }, true)).toEqual({ source: 'report', text: worker.lastReport! });
		expect(workerDoingNow(worker, { ...task, id: 'T4' }, true)?.source).toBe('report');
	});
	test('old backends, disabled activity, absent tasks and empty phases use the report, never task report prose', () => {
		for (const missing of [undefined, null, { ...task, activity: undefined }, { ...task, activity: { ...activity, text: '  ' } }]) {
			expect(workerDoingNow(worker, missing, true)?.source).toBe('report');
		}
		expect(workerDoingNow(worker, task)?.source).toBe('report');
		expect(workerDoingNow(worker, task, false)?.source).toBe('report');
		for (const lastReport of [null, '', '  ']) expect(workerDoingNow({ ...worker, lastReport }, null, true)).toBeUndefined();
	});
});

test('runs-in wording describes isolation, not a path', () => {
	expect(workerRunsIn('shared')).toBe('shared checkout');
	expect(workerRunsIn('workspace')).toBe('its own workspace');
});

test('main uses the project transcript, a background worker preserves its thread', () => {
	expect(workerTranscriptThread(worker)).toBeUndefined();
	expect(workerTranscriptThread({})).toBeUndefined();
	expect(workerTranscriptThread({ threadId: 'bakery' })).toBe('bakery');
});

test('WorkerPeek renders worker and background job content, scoped links and sheet layout', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'kemiri-worker-peek-'));
	const vite = await createServer({ root: import.meta.dir + '/..', cacheDir: join(directory, 'cache'), server: { middlewareMode: true }, logLevel: 'error' });
	try {
		const { default: WorkerPeek } = await vite.ssrLoadModule('/src/lib/components/WorkerPeek.svelte');
		const { render } = await vite.ssrLoadModule('svelte/server');
		const props = { backendId: 'demo', projectId: 'bakery', onOpenTask: () => {} };
		const body = render(WorkerPeek, { props: { ...props, worker, task, activityEnabled: true } }).body;
		for (const text of [worker.id, worker.title, activity.text, worker.lastReport!, 'Doing now', 'Last report', 'thinking default', 'shared checkout', 'Started', 'Open transcript', '/b/demo/projects/bakery/workers/photo']) expect(body).toContain(text);
		expect(body.match(/<defs>/g)).toHaveLength(1);
		expect(body).toContain('data-state="working"');
		const failed = render(WorkerPeek, { props: { ...props, worker: { ...worker, threadId: 'oven', isolation: 'workspace', status: 'failed', failure: 'The driver install failed twice.' }, layout: 'sheet' } }).body;
		for (const text of ['Why it failed', 'The driver install failed twice.', 'its own workspace', '/b/demo/projects/bakery/threads/oven/workers/photo', 'sheet', 'data-state="failed"']) expect(failed).toContain(text);
		expect(failed).not.toContain('Doing now');
		const resting = render(WorkerPeek, { props: { ...props, worker: { ...worker, status: 'idle', taskId: null } } }).body;
		expect(resting).toContain('No task');
		expect(resting).toContain('data-state="sleeping"');
		expect(resting).not.toContain('Open task');
		const waiting = render(WorkerPeek, { props: { ...props, worker: { ...worker, status: 'idle' }, task: { ...task, status: 'review' } } }).body;
		expect(waiting).toContain('data-state="thinking"');
		const thread: ThreadSummary = { id: 'bakery-job', title: 'Plan the market', status: 'running', main: false, startedBy: 'main', scheduleId: null, conversationId: 20, model: null, thinkingLevel: 'high', onFinish: 'review', runningWorkers: 1, taskId: 'T3', ownedTasks: ['T3'], openQuestions: 0, current: 'Running checks', summary: null, failure: null, createdAt: worker.createdAt, updatedAt: worker.updatedAt, finishedAt: null, archived: false };
		const job = render(WorkerPeek, { props: { ...props, thread, task } }).body;
		for (const text of ['Background job', 'Running checks', 'Open chat', '/b/demo/projects/bakery/threads/bakery-job', 'thinking high', 'its own workspace', 'No model']) expect(job).toContain(text);
		expect(job).not.toContain('Open transcript');
	} finally { await vite.close(); await rm(directory, { recursive: true, force: true }); }
}, 20_000);
