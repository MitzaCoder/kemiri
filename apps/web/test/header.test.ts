import { describe, expect, test } from 'bun:test';
import { headerHasRoomForApps, headerLayout, visibleHeaderActions, type HeaderActionWidth } from '../src/lib/chat/header.ts';

const tools = [{ label: 'Files' }, { label: 'Changes' }, { label: 'Terminal' }];
const apps = { id: 'apps', placement: 'persistent' } as const;
const panel = { label: 'Panel', badge: true, placement: 'persistent' } as const;
const settings = { label: 'Project settings', placement: 'more' } as const;
const chatActions: (HeaderActionWidth & { id?: string })[] = [...tools, apps, panel, settings];
const phoneRow = 390 - 16; // the measured row excludes padding
const drawerAndInbox = 84;

describe('chat header layout', () => {
	test('labels fit on desktop with a docked panel, settings stay under More', () => {
		const besidePanel = [...tools, apps, settings];
		const layout = headerLayout(650, besidePanel);
		expect(layout).toBe('labels');
		expect(visibleHeaderActions(layout, besidePanel)).toEqual({ inline: [...tools, apps], menu: [settings] });
	});

	test('folds to icons before moving the tools into More', () => {
		const layout = headerLayout(480, chatActions);
		expect(layout).toBe('icons');
		expect(visibleHeaderActions(layout, chatActions)).toEqual({ inline: [...tools, apps, panel], menu: [settings] });
	});

	test('a phone reserves the title space and keeps active apps and Panel in reach', () => {
		for (const width of [phoneRow, 320 - 16]) {
			const layout = headerLayout(width, chatActions, drawerAndInbox);
			expect(layout).toBe('menu');
			expect(visibleHeaderActions(layout, chatActions)).toEqual({ inline: [apps, panel], menu: [...tools, settings] });
		}
	});

	test('the connection problem chip can fold tools earlier and moves apps into More if the title would be squeezed', () => {
		expect(headerLayout(480, chatActions)).toBe('icons');
		const layout = headerLayout(480, chatActions, 108);
		expect(layout).toBe('menu');
		expect(visibleHeaderActions(layout, chatActions).inline).toEqual([apps, panel]);
		expect(headerHasRoomForApps(phoneRow, drawerAndInbox)).toBe(true);
		expect(headerHasRoomForApps(phoneRow, drawerAndInbox + 108)).toBe(false);
	});
});
