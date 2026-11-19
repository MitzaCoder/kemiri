import { expect, test } from 'bun:test';
import { NOTIFICATION_KINDS } from '@kemiri/client';
import { DEFAULT_NOTIFICATION_KINDS, NOTIFICATION_FAILURE_KINDS, NOTIFICATION_PRESETS } from '@kemiri/protocol';
import { NOTIFICATION_ALERT_GROUPS, notificationPreset } from '../src/lib/notifications.ts';
import { COLOR_SCHEME_STORAGE_KEY, isDarkScheme, parseColorScheme } from '../src/lib/themes/color-scheme.ts';

test('notification presets use exact sets and individual alerts cover every kind once', () => {
	expect(NOTIFICATION_PRESETS.important).toEqual(DEFAULT_NOTIFICATION_KINDS);
	expect(NOTIFICATION_PRESETS.needed).toEqual(['login_prompt', 'board_question', 'task_review', ...NOTIFICATION_FAILURE_KINDS]);
	expect([...NOTIFICATION_PRESETS.everything].sort()).toEqual([...NOTIFICATION_KINDS].sort());
	expect(NOTIFICATION_ALERT_GROUPS.flatMap(({ kinds }) => [...kinds]).sort()).toEqual([...NOTIFICATION_KINDS].sort());
	for (const preset of ['important', 'needed', 'everything'] as const) {
		const kinds = NOTIFICATION_PRESETS[preset];
		expect(notificationPreset([...kinds].reverse())).toBe(preset);
		expect(notificationPreset([...kinds, kinds[0]!])).toBe(preset);
		expect(notificationPreset(kinds.slice(1))).toBe('custom');
	}
	expect(notificationPreset([])).toBe('custom');
});

test('the inline first-paint script uses the same light/dark rules as the setting', async () => {
	const html = await Bun.file(new URL('../src/app.html', import.meta.url)).text();
	const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
	if (!script) throw new Error('Missing color scheme bootstrap');
	const bootstrap = new Function('document', 'window', 'localStorage', script);
	for (const stored of [null, 'invalid', 'device', 'light', 'dark']) {
		for (const deviceDark of [false, true]) {
			let appliedDark: boolean | undefined;
			let systemChanged: (() => void) | undefined;
			const root = { dataset: {}, classList: { toggle: (name: string, on: boolean) => {
				expect(name).toBe('dark');
				appliedDark = on;
			} } };
			const media = { matches: deviceDark, addEventListener: (_event: string, callback: () => void) => { systemChanged = callback; } };
			bootstrap({ documentElement: root }, { matchMedia: () => media }, { getItem: (key: string) => key === COLOR_SCHEME_STORAGE_KEY ? stored : null });
			const preference = parseColorScheme(stored);
			expect(preference).toBe(stored === 'light' || stored === 'dark' ? stored : 'device');
			expect(appliedDark).toBe(isDarkScheme(preference, deviceDark));
			media.matches = !deviceDark;
			systemChanged?.();
			expect(appliedDark).toBe(isDarkScheme(preference, !deviceDark));
		}
	}
});
