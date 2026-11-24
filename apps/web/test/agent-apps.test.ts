import { expect, test } from 'bun:test';
import type { ProjectApp } from '@kemiri/protocol';
import { appCountLabel, appCounts, appIdFromCall, appLink, appStateLabel, visibleApps } from '../src/lib/agent-apps.js';

const app: ProjectApp = {
	appId: 'orders', name: 'Orders', projectId: 'bakery', taskId: 'T1', port: 41340, path: '/',
	url: 'http://oven.example.test:41340/', mode: 'template', state: 'live',
	createdAt: '2026-01-01T12:00:00Z', publishedBy: { kind: 'worker', id: 'orders', threadId: 'main', conversationId: 14 },
};

test('Running apps shows live and pending rows, while the task row is scoped to that task', () => {
	const pending: ProjectApp = { ...app, appId: 'docs', taskId: 'T2', state: 'pending', url: null };
	const unpublished: ProjectApp = { ...app, appId: 'old', state: 'unpublished', url: null };
	const apps = [app, pending, unpublished];
	expect(visibleApps(apps)).toEqual([app, pending]);
	expect(visibleApps(apps, 'T1')).toEqual([app]);
	expect(appCountLabel(appCounts(apps))).toBe('1 app running · 1 pending');
	expect(appCounts(apps)).toEqual({ running: 1, pending: 1, active: 2 });
	expect(appCounts([pending]).active).toBe(1);
	expect(appStateLabel(pending)).toBe('Waiting for approval');
});

test('the card gets identity from the tool call, but only a live HTTP address from the registry may open', () => {
	expect(appIdFromCall({ details: { app: { appId: app.appId } } })).toBe(app.appId);
	expect(appIdFromCall({ output: JSON.stringify({ appId: app.appId }) })).toBe(app.appId);
	expect(appIdFromCall({ output: JSON.stringify({ appId: app.appId }), isError: true })).toBeUndefined();
	expect(appLink(app)).toBe(app.url);
	expect(appLink({ ...app, state: 'unpublished' })).toBeNull();
	expect(appLink({ ...app, state: 'pending' })).toBeNull();
	expect(appLink({ ...app, url: 'javascript:void(0)' })).toBeNull();
	expect(appLink({ ...app, url: 'https://secret@example.test' })).toBeNull();
	expect(appStateLabel({ ...app, url: null })).toBe('No address configured');
});

test('a stopped app keeps a task row but loses its link and running count', () => {
	const stopped: ProjectApp = { ...app, state: 'stopped' };
	expect(visibleApps([stopped], 'T1')).toEqual([stopped]);
	expect(appCounts([stopped]).active).toBe(0);
	expect(appLink(stopped)).toBeNull();
	expect(appStateLabel(stopped)).toBe(`Stopped · nothing listens on port ${stopped.port} any more`);
});
