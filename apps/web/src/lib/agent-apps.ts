import type { ProjectApp } from '@kemiri/protocol';

export const APP_LINK_WARNING = 'Anyone on your tailnet can open these links. They are not behind Kemiri sign-in.';

export function visibleApps(apps: readonly ProjectApp[], taskId?: string): ProjectApp[] {
	return apps.filter(app => app.state !== 'unpublished' && (taskId === undefined || taskId === app.taskId));
}

export function appCounts(apps: readonly ProjectApp[]) {
	const running = apps.filter(app => app.state === 'live').length;
	const pending = apps.filter(app => app.state === 'pending').length;
	return { running, pending, active: running + pending };
}

export function appCountLabel({ running, pending }: ReturnType<typeof appCounts>): string {
	return `${running} ${running === 1 ? 'app' : 'apps'} running${pending ? ` · ${pending} pending` : ''}`;
}

export function appLink(app: Pick<ProjectApp, 'state' | 'url'>): string | null {
	if (app.state !== 'live' || !app.url) return null;
	try {
		const url = new URL(app.url);
		if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
	} catch { /* Do not open a malformed address. */ }
	return null;
}

export function appStateLabel(app: ProjectApp): string {
	if (app.state === 'stopped') return `Stopped · nothing listens on port ${app.port} any more`;
	if (app.state === 'pending') return 'Waiting for approval';
	if (app.state === 'unpublished') return 'Unpublished';
	return appLink(app) ? 'Live' : 'No address configured';
}

export function appIdFromCall(part: { details?: unknown; output?: string; isError?: boolean }): string | undefined {
	if (part.isError) return;
	const details = part.details as { app?: { appId?: unknown } } | undefined;
	if (typeof details?.app?.appId === 'string') return details.app.appId;
	try {
		const receipt = JSON.parse(part.output ?? '') as { appId?: unknown } | null;
		if (typeof receipt?.appId === 'string') return receipt.appId;
	} catch { /* Not a publish receipt. */ }
}