import { isBackendMuted, isProjectMuted, mutedBackendEntries, mutedProjectEntries, type DeviceNotificationSettings } from '@kemiri/client';
import type { NotificationMute } from '@kemiri/protocol';

const HOUR_MS = 60 * 60_000;
export const MUTE_DURATIONS = [
	{ id: 'hour', label: 'For 1 hour' }, { id: 'eight-hours', label: 'For 8 hours' }, { id: 'indefinite', label: 'Until turned back on' },
] as const;
export const DO_NOT_DISTURB_DURATIONS = [
	{ id: 'hour', label: 'For 1 hour' }, { id: 'tomorrow', label: 'Until tomorrow morning (08:00)' }, { id: 'indefinite', label: 'Until turned off' },
] as const;
export type MuteDuration = typeof MUTE_DURATIONS[number]['id'];
export type DoNotDisturbDuration = typeof DO_NOT_DISTURB_DURATIONS[number]['id'];

export function quietPeriod(duration: MuteDuration | DoNotDisturbDuration, now: number): NotificationMute {
	if (duration === 'indefinite') return {};
	if (duration === 'tomorrow') {
		const morning = new Date(now);
		morning.setDate(morning.getDate() + 1);
		morning.setHours(8, 0, 0, 0);
		return { until: morning.getTime() };
	}
	return { until: now + (duration === 'eight-hours' ? 8 : 1) * HOUR_MS };
}

export function activeDoNotDisturb(value: unknown, now: number): NotificationMute | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const { until } = value as { until?: unknown };
	if (until === undefined) return {};
	return typeof until === 'number' && Number.isSafeInteger(until) && until > now && until <= 8.64e15 ? { until } : null;
}

type DeviceMutes = Pick<DeviceNotificationSettings, 'mutedProjects' | 'projectMutes' | 'backendMutes'>;
export function alertOriginMuted(settings: DeviceMutes, backendId: string, projectId: string | null, now: number): boolean {
	return isBackendMuted(settings, backendId, now) || (projectId !== null && isProjectMuted(settings, backendId, projectId, now));
}

export function nextDeviceMuteDeadline(settings: DeviceMutes, now: number): number | undefined {
	const deadlines = [...mutedProjectEntries(settings, now), ...mutedBackendEntries(settings, now)].flatMap(mute => mute.until ?? []);
	return deadlines.length ? Math.min(...deadlines) : undefined;
}

export function quietUntilLabel(mute: NotificationMute, now: number, indefinite = 'Until turned back on'): string {
	if (mute.until === undefined) return indefinite;
	const end = new Date(mute.until);
	const today = end.toDateString() === new Date(now).toDateString();
	return 'Until ' + end.toLocaleString(undefined, {
		...(!today ? { month: 'short', day: 'numeric' } as const : {}), hour: 'numeric', minute: '2-digit',
	});
}

export function quietTimerDelay(deadline: number, now: number): number {
	return Math.max(0, Math.min(deadline - now, 2_147_483_647));
}
