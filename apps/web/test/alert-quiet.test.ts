import { expect, test } from 'bun:test';
import { defaultDeviceSettings, preferencesForBackend, withBackendMute, withProjectMute } from '@kemiri/client';
import { activeDoNotDisturb, alertOriginMuted, DO_NOT_DISTURB_DURATIONS, MUTE_DURATIONS, nextDeviceMuteDeadline, quietPeriod } from '../src/lib/alert-quiet.js';
import { alertPopupDecision, type AlertContext } from '../src/lib/alerts.js';

const now = new Date(2026, 0, 12, 23, 30).getTime();
const hour = 60 * 60_000;

test('a timed choice comes first and tomorrow is at 08:00 local time', () => {
	expect(DO_NOT_DISTURB_DURATIONS[0].id).toBe('hour');
	expect(MUTE_DURATIONS[0].id).toBe('hour');
	expect(quietPeriod('hour', now)).toEqual({ until: now + hour });
	expect(quietPeriod('eight-hours', now)).toEqual({ until: now + 8 * hour });
	expect(quietPeriod('tomorrow', now)).toEqual({ until: new Date(2026, 0, 13, 8).getTime() });
	expect(activeDoNotDisturb(quietPeriod('indefinite', now), now + 100 * hour)).toEqual({});
	expect(activeDoNotDisturb({ until: now }, now)).toBeNull();
	expect(activeDoNotDisturb({ until: 'tomorrow' }, now)).toBeNull();
});

test('project and backend mutes use exact scopes and expire without suppressing other backends', () => {
	const defaults = defaultDeviceSettings('fixture-device', 'UTC');
	const settings = withBackendMute(withProjectMute(defaults, 'lab', 'recipes', quietPeriod('hour', now), now), 'studio', quietPeriod('eight-hours', now), now);
	expect(alertOriginMuted(settings, 'lab', 'recipes', now)).toBe(true);
	expect(alertOriginMuted(settings, 'lab', 'unrelated', now)).toBe(false);
	expect(alertOriginMuted(settings, 'studio', null, now)).toBe(true);
	expect(alertOriginMuted(settings, 'another', 'recipes', now)).toBe(false);
	expect(alertOriginMuted(settings, 'lab', 'recipes', now + hour)).toBe(false);
	expect(nextDeviceMuteDeadline(settings, now)).toBe(now + hour);
	expect(nextDeviceMuteDeadline(settings, now + hour)).toBe(now + 8 * hour);
});

test('the same device settings send optional wire mutes only to supporting push backends', () => {
	const defaults = defaultDeviceSettings('fixture-device', 'UTC');
	const timed = withProjectMute(defaults, 'lab', 'recipes', quietPeriod('hour', now), now);
	const settings = withBackendMute(withProjectMute(timed, 'lab', 'garden', {}, now), 'lab', {}, now);
	const options = { now, supportsTimedMutes: true };
	expect(preferencesForBackend(settings, 'lab', true, true, options)).toMatchObject({
		mutedProjects: ['garden'], projectMutes: [{ projectId: 'recipes', until: now + hour }], backendMute: {},
	});
	const legacy = preferencesForBackend(settings, 'lab', true, true, { ...options, supportsTimedMutes: false });
	expect(legacy.mutedProjects).toEqual(['garden']);
	expect(legacy.projectMutes).toBeUndefined();
	expect(legacy.backendMute).toBeUndefined();
	const cleared = withBackendMute(withProjectMute(settings, 'lab', 'recipes', null, now), 'lab', null, now);
	expect(preferencesForBackend(cleared, 'lab', true, true, options).projectMutes).toBeUndefined();
	expect(preferencesForBackend(cleared, 'lab', true, true, options).backendMute).toBeUndefined();
});

test('Do not disturb and local mutes block even urgent pop-ups without upgrading any other policy', () => {
	const alert = { level: 'urgent', kind: 'deploy_problem', projectId: 'recipes' } as const;
	const context: AlertContext = { backendId: 'lab', visible: true, soundAllowed: true, setting: 'everything' };
	expect(alertPopupDecision(alert, context)).toEqual({ pop: true, silent: false });
	expect(alertPopupDecision(alert, { ...context, doNotDisturb: true })).toEqual({ pop: false, silent: true });
	expect(alertPopupDecision(alert, { ...context, muted: true })).toEqual({ pop: false, silent: true });
});
