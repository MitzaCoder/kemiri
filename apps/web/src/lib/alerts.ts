import type { NotificationAlert, NotificationAlertLevel, NotificationRecentEntry } from '@kemiri/protocol';

export const ALERT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const ALERT_BURST_WINDOW_MS = 5_000;
export const ALERT_CATCH_UP_WINDOW_MS = 2 * 60_000;
export const DEFAULT_ALERT_POPUPS = 'needs-me';
export type AlertPopupSetting = 'everything' | 'needs-me' | 'urgent' | 'off';

export type AlertScreen = { backendId: string; projectId: string; coordinatorId?: string; taskId?: string | null };
export type AlertContext = {
	backendId: string;
	screen?: AlertScreen;
	setting: AlertPopupSetting;
	visible: boolean;
	soundAllowed: boolean;
	muted?: boolean;
	doNotDisturb?: boolean;
};
export type AlertCursor = { backendEpoch: string; seq: number };
export type AlertRow = {
	backendId: string;
	alert: NotificationAlert;
	read: boolean;
	done: boolean;
	shown: boolean;
	dismissed: boolean;
};

type AlertPolicyInput = Pick<NotificationAlert, 'kind' | 'level' | 'projectId'> &
	Partial<Pick<NotificationAlert, 'taskId' | 'coordinatorId' | 'threadId'>>;

export function alertPopupSetting(value: unknown): AlertPopupSetting {
	return value === 'everything' || value === 'urgent' || value === 'off' ? value : DEFAULT_ALERT_POPUPS;
}

export function alertSourceLabel(projectName: string | undefined, backendName: string | undefined, connectedBackends: number): string {
	if (!projectName) return backendName || 'Kemiri';
	return connectedBackends > 1 && backendName ? `${projectName} · ${backendName}` : projectName;
}

export function alertPopupDecision(alert: AlertPolicyInput, context: AlertContext): { pop: boolean; silent: boolean } {
	const { screen, setting, visible, backendId, soundAllowed } = context;
	const sameProject = screen !== undefined && screen.backendId === backendId && screen.projectId === alert.projectId;
	const coordinator = alert.coordinatorId ?? alert.threadId ?? 'main';
	const onScreen = sameProject && (screen.taskId
		? screen.taskId === alert.taskId
		: screen.coordinatorId === coordinator);
	const allowed = alert.level !== 'inbox' && alert.kind !== 'compaction_failed' && alert.kind !== 'maintenance_failed' &&
		(setting === 'everything' || (setting === 'needs-me' && alert.level !== 'info') || (setting === 'urgent' && alert.level === 'urgent'));
	const pop = visible && allowed && !onScreen && !context.muted && !context.doNotDisturb;
	return { pop, silent: !pop || !soundAllowed || alert.level === 'info' || (sameProject && screen.coordinatorId !== undefined && screen.coordinatorId !== coordinator) };
}

export function mergesAlertBurst(previousArrivals: readonly number[], now: number): boolean {
	return previousArrivals.filter(at => at <= now && now - at <= ALERT_BURST_WINDOW_MS).length >= 3;
}

/** The caller supplies only unresolved, pop-up-eligible, unseen rows. */
export function catchUpPresentation(cursor: AlertCursor | undefined, epoch: string, rows: readonly AlertRow[], now: number): 'none' | 'individual' | 'summary' {
	if (cursor?.backendEpoch !== epoch || !rows.length) return 'none';
	return rows.length <= 3 && rows.every(({ alert }) => now - Date.parse(alert.at) < ALERT_CATCH_UP_WINDOW_MS) ? 'individual' : 'summary';
}

export function alertRowId({ backendId, alert }: Pick<AlertRow, 'backendId' | 'alert'>): string {
	return JSON.stringify([backendId, alert.backendEpoch, alert.key]);
}

export function recentAlertSequence(entry: NotificationRecentEntry): number {
	return entry.type === 'alert' ? entry.alert.seq : entry.seq;
}

/** History carries authoritative resolved flags. A live delivery overlapping that snapshot is still one event. */
export function reconcileAlertEntries(history: readonly NotificationRecentEntry[], live: readonly NotificationRecentEntry[]): NotificationRecentEntry[] {
	const entries = new Map(history.map(entry => [recentAlertSequence(entry), entry]));
	for (const entry of live) {
		const sequence = recentAlertSequence(entry);
		if (!entries.has(sequence)) entries.set(sequence, entry);
	}
	return [...entries.values()].sort((a, b) => recentAlertSequence(a) - recentAlertSequence(b));
}

export function applyAlertEntry(rows: readonly AlertRow[], backendId: string, entry: NotificationRecentEntry): AlertRow[] {
	if (entry.type === 'resolved') {
		return rows.map(row => row.backendId === backendId && row.alert.backendEpoch === entry.backendEpoch &&
			row.alert.seq < entry.seq && entry.tags.includes(row.alert.tag) ? { ...row, done: true } : row);
	}
	const incoming = entry.alert;
	const previous = rows.find(row => row.backendId === backendId && row.alert.backendEpoch === incoming.backendEpoch && row.alert.key === incoming.key);
	const sameTag = (row: AlertRow) => row.backendId === backendId && row.alert.backendEpoch === incoming.backendEpoch && row.alert.tag === incoming.tag;
	const updated: AlertRow = {
		backendId, alert: incoming, read: previous?.read ?? false, shown: previous?.shown ?? false,
		dismissed: previous?.dismissed ?? false,
		done: entry.resolved || previous?.done === true || rows.some(row => sameTag(row) && row.alert.seq > incoming.seq),
	};
	return [updated, ...rows.filter(row => row !== previous).map(row =>
		sameTag(row) && row.alert.seq < incoming.seq && !row.done ? { ...row, done: true } : row)];
}

type AnswerableAlert = Pick<NotificationAlert, 'projectId' | 'questionId' | 'questionRevision'> & {
	projectId: string;
	questionId: string;
	questionRevision: number;
	choices: NonNullable<NotificationAlert['choices']>;
};

export function canAnswerAlert(alert: NotificationAlert): alert is NotificationAlert & AnswerableAlert {
	return alert.kind === 'board_question' && !alert.warning && !alert.approval && alert.projectId !== null &&
		alert.questionId !== undefined && alert.questionRevision !== undefined && alert.choices !== undefined &&
		alert.choices.length >= 1 && alert.choices.length <= 3 &&
		new Set(alert.choices.map(choice => choice.label)).size === alert.choices.length &&
		alert.choices.every(choice => choice.label.trim() && Array.from(choice.label).length <= 24);
}

export function alertDuration(level: NotificationAlertLevel, warning = false): number {
	return warning || level === 'urgent' ? 10 * 60_000 : level === 'important' ? 10_000 : level === 'info' ? 6_000 : 0;
}

export function alertTimeRemaining(remaining: number, elapsed: number, showing: boolean, paused: boolean): number {
	return showing && !paused ? Math.max(0, remaining - elapsed) : remaining;
}
