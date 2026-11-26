import type { Board, Overview } from '@kemiri/protocol';

export function overviewTime(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	if (minutes < 1) return 'less than a minute';
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	if (hours >= 24) return `${Math.floor(hours / 24)} d${hours % 24 ? ` ${hours % 24} h` : ''}`;
	return hours ? `${hours} h${remainder ? ` ${remainder} min` : ''}` : `${minutes} min`;
}

export const overviewAge = (since: string, now: number) => overviewTime(now - Date.parse(since));
export const plural = (count: number, singular: string, multiple = `${singular}s`) => `${count} ${count === 1 ? singular : multiple}`;

export function overviewOpeningLine(counts: Overview['counts'], now: number, coordinators?: number): string {
	const open = `${plural(counts.open, 'request')} ${counts.open === 1 ? 'is' : 'are'} open${coordinators && coordinators > 1 ? ` across ${plural(coordinators, 'coordinator')}` : ''}`;
	if (counts.waitingOnOwner === 0) return `${open}, and nothing waits on you.`;
	const oldest = counts.oldestWaitSince ? ` for up to ${overviewAge(counts.oldestWaitSince, now)}` : '';
	return `${open}, and ${plural(counts.waitingOnOwner, 'thing')} ${counts.waitingOnOwner === 1 ? 'waits' : 'wait'} on you${oldest}.`;
}

export function overviewRosterLine(counts: Overview['counts'] | undefined): string | undefined {
	if (!counts) return undefined;
	return `${plural(counts.open, 'request')} open · ${counts.waitingOnOwner} ${counts.waitingOnOwner === 1 ? 'waits' : 'wait'} on you`;
}

export function overviewFlightRows(rows: Overview['inFlight'], board: Board | undefined) {
	const tasks = new Map(board?.tasks.map(task => [task.id, task]));
	const rank = (id: string) => {
		const kind = tasks.get(id)?.state?.kind;
		return kind === 'failed' ? 0 : kind === 'paused' ? 1 : 2;
	};
	return [...rows].sort((a, b) => rank(a.requestId) - rank(b.requestId));
}

export function overviewWaitingRows(rows: Overview['waiting']) {
	return [...rows].sort((a, b) => a.since.localeCompare(b.since));
}

export function overviewWaitHref(wait: Overview['waiting'][number], taskHref: (id: string) => string, questionHref: (id: string) => string) {
	if (wait.taskId) {
		const href = taskHref(wait.taskId);
		return wait.questionId ? `${href}#task-question-${encodeURIComponent(wait.questionId)}` : wait.kind === "steps" ? `${href}#task-steps` : href;
	}
	return wait.questionId ? questionHref(wait.questionId) : undefined;
}
