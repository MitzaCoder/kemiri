import { expect, test } from 'bun:test';
import { alertPopupDecision, type AlertContext } from '../src/lib/alerts.js';
import { AlertSoundPlayer, DEFAULT_ALERT_VOLUME, alertSoundDecision, alertSoundProjectKey, alertSoundSetting, alertVolume, noteAlertSound, scheduleAlertTone, type AlertSoundHistory } from '../src/lib/alert-sounds.js';

const fresh: AlertSoundHistory = { softAt: {} };
const midnight = Date.parse('2026-01-05T00:30:00Z');
const projectKey = alertSoundProjectKey('Lab', 'recipes');
const facts: Parameters<typeof alertSoundDecision>[0] = { level: 'urgent', setting: 'urgent', popupVisible: true, permitted: true, quietHours: null, projectKey };

test('only an eligible, permitted, displayed alert can sound, urgent by default', () => {
	expect(alertSoundSetting(undefined)).toBe('urgent');
	expect(alertVolume(undefined)).toBe(DEFAULT_ALERT_VOLUME);
	expect(alertVolume(102)).toBe(100);
	expect(alertSoundDecision(facts, fresh, midnight)).toBe('urgent');
	for (const change of [{ setting: 'off' }, { level: 'important' }, { level: 'info', setting: 'urgent-important' },
		{ level: 'inbox', setting: 'urgent-important' }, { popupVisible: false }, { permitted: false }] as const) {
		expect(alertSoundDecision({ ...facts, ...change }, fresh, midnight)).toBeUndefined();
	}
	const alert = { kind: 'board_question', level: 'urgent', projectId: 'recipes' } as const;
	const context: AlertContext = { backendId: 'lab', setting: 'needs-me', visible: true, soundAllowed: true };
	const here = { ...context, screen: { backendId: 'lab', projectId: 'recipes', coordinatorId: 'main' } };
	expect(alertPopupDecision(alert, here)).toEqual({ pop: false, silent: true });
	expect(alertPopupDecision(alert, { ...here, screen: { ...here.screen, coordinatorId: 'baking' } })).toEqual({ pop: true, silent: true });
});

test('quiet hours silence even allowed urgent failures; history never supplies a permission', () => {
	const quietHours = { start: '22:00', end: '07:00', timezone: 'UTC', allowFailures: true };
	expect(alertSoundDecision({ ...facts, quietHours }, fresh, midnight)).toBeUndefined();
	expect(alertSoundDecision({ ...facts, quietHours }, fresh, midnight + 12 * 60 * 60_000)).toBe('urgent');
	expect(alertSoundDecision({ ...facts, catchUp: true, permitted: false, unresolved: true }, fresh, midnight)).toBeUndefined();
	expect(alertSoundDecision({ ...facts, catchUp: true, unresolved: false }, fresh, midnight)).toBeUndefined();
	expect(alertSoundDecision({ ...facts, catchUp: true, unresolved: true }, fresh, midnight)).toBe('urgent');
});

test('rate limits are global for 8 seconds and per backend/project for the soft note', () => {
	const soft = { ...facts, level: 'important', setting: 'urgent-important' } as const;
	const history = noteAlertSound(fresh, 'soft', projectKey, midnight);
	expect(alertSoundDecision(facts, history, midnight + 7_999)).toBeUndefined();
	expect(alertSoundDecision(facts, history, midnight + 8_000)).toBe('urgent');
	expect(alertSoundDecision(soft, history, midnight + 119_999)).toBeUndefined();
	expect(alertSoundDecision(soft, history, midnight + 120_000)).toBe('soft');
	expect(alertSoundDecision({ ...soft, projectKey: alertSoundProjectKey('Studio', 'recipes') }, history, midnight + 8_000)).toBe('soft');
});

test('Web Audio schedules rising sine notes, shaped gain and one lower soft note', () => {
	const notes: { hz?: number; start?: number; stop?: number; type?: string; connected?: boolean }[] = [];
	const ramps: number[] = [];
	const context = {
		currentTime: 2,
		destination: {},
		createOscillator() {
			const note = { frequency: { setValueAtTime: (hz: number) => { note.hz = hz; } }, connect: () => { note.connected = true; },
				start: (at: number) => { note.start = at; }, stop: (at: number) => { note.stop = at; } } as typeof notes[number] & { frequency: unknown };
			notes.push(note);
			return note;
		},
		createGain: () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime: (value: number) => { ramps.push(value); } }, connect() {} }),
	} as unknown as Parameters<typeof scheduleAlertTone>[0];
	expect(scheduleAlertTone(context, 'urgent', 40)).toBe(true);
	expect(notes.map(note => note.hz)).toEqual([659.25, 880]);
	expect(notes.every(note => note.connected && note.type === 'sine')).toBe(true);
	expect(notes[1]!.stop! - notes[0]!.start!).toBeCloseTo(0.3);
	expect(ramps[0]).toBeCloseTo(0.072);
	expect(ramps[3]).toBe(0);
	expect(scheduleAlertTone(context, 'soft', 40)).toBe(true);
	expect(notes[2]?.hz).toBe(392);
	expect(scheduleAlertTone(context, 'soft', 0)).toBe(false);
	expect(notes).toHaveLength(3);
	expect(new AlertSoundPlayer().play('urgent', 40)).toBeFalsy();
});
