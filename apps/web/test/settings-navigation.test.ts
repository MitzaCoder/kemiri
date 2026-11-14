import { describe, expect, test } from 'bun:test';
import {
	closeAction, inAppBackVisible, localHref, sectionNavigation, settingsSurface, upAction, visitEntry,
	type NavigationAction, type NavigationEntry,
} from '../src/lib/settings-navigation.ts';

const origin = 'https://example.com';
const S = '/b/sample/projects/garden/settings';
type Entry = { href: string; navigation: NavigationEntry; overlay?: string };
/** Like browser history: go keeps forward entries; only a new push truncates them. */
class BrowserHistory {
	entries: Entry[];
	index: number;
	constructor(hrefs = ['/previous', '/chat?task=T1#reply']) {
		this.entries = hrefs.map((href, index) => ({ href, navigation: { index } }));
		this.index = hrefs.length - 1;
	}
	get current() { return this.entries[this.index]!; }
	move(href: string, replace = false, overlay?: string) {
		const current = this.current;
		const navigation = visitEntry(current.navigation, current.href, origin, 'visit-1', replace,
			settingsSurface(current.href.split(/[?#]/)[0]!) || !!current.overlay);
		const entry = { href, navigation, overlay };
		if (replace) this.entries[this.index] = entry;
		else { this.entries.splice(++this.index); this.entries.push(entry); }
	}
	go(delta: number) { this.index = Math.max(0, Math.min(this.entries.length - 1, this.index + delta)); }
	act(action: NavigationAction) {
		if (action.type === 'pop') this.go(-action.count);
		else this.entries[this.index] = { href: action.href, navigation: this.current.navigation };
	}
	up(parent: string) { this.act(upAction(this.current.navigation, parent)); }
	close(fallback = '/') { this.act(closeAction(this.current.navigation, fallback, origin)); }
	assert(hrefs: string[], index = hrefs.length - 1) {
		expect(this.entries.map(entry => entry.href + (entry.overlay ? ` [${entry.overlay}]` : ''))).toEqual(hrefs);
		expect(this.index).toBe(index);
	}
}
const chat = '/chat?task=T1#reply';
const start = ['/previous', chat];

describe('settings history policy', () => {
	test('validates exact local origins, rejecting external, malformed and script targets', () => {
		expect(localHref('/chat?task=T1#reply', origin)).toBe(chat);
		expect(localHref(origin + chat, origin)).toBe(chat);
		for (const href of ['https://other.example/chat', '//other.example/chat', 'javascript:alert(1)', '/\\other.example', '/ bad', 'relative']) {
			expect(localHref(href, origin)).toBeUndefined();
		}
	});
	test('children push, section switches replace, Back is only shown for a known prior app entry', () => {
		expect(sectionNavigation(undefined)).toBe('push');
		expect(sectionNavigation('coordinator')).toBe('replace');
		expect(sectionNavigation('backends', '/settings/backends/sample/accounts', '/settings/backends')).toBe('up');
		expect(sectionNavigation('backends', '/settings/backends', '/settings/backends')).toBe('stay');
		expect(inAppBackVisible(undefined)).toBe(false);
		expect(inAppBackVisible({ index: 0 })).toBe(false);
		expect(inAppBackVisible({ index: 1 })).toBe(true);
	});
	test('untrusted origins never pop; Up can pop multiple entries but never pushes', () => {
		const navigation = { index: 4, visit: { id: 'v', originHref: '//other.example/', originIndex: 0, entries: [{ href: '/settings', index: 1 }] } };
		expect(closeAction(navigation, '/', origin)).toEqual({ type: 'replace', href: '/' });
		expect(upAction(navigation, '/settings')).toEqual({ type: 'pop', count: 3 });
		expect(upAction(navigation, '/settings/backends')).toEqual({ type: 'replace', href: '/settings/backends' });
	});
	test('W1: phone child → Up pops; the next Back leaves settings', () => {
		const h = new BrowserHistory();
		h.move(S); h.assert([...start, S]);
		h.move(S + '/coordinator'); h.assert([...start, S, S + '/coordinator']);
		h.up(S); h.assert([...start, S, S + '/coordinator'], 2);
		h.go(-1); h.assert([...start, S, S + '/coordinator'], 1);
	});
	test('W2: desktop child pushes, siblings replace, Close pops to the exact launch URL', () => {
		const h = new BrowserHistory();
		h.move(S); h.assert([...start, S]);
		h.move(S + '/coordinator'); h.assert([...start, S, S + '/coordinator']);
		h.move(S + '/workers', true); h.assert([...start, S, S + '/workers']);
		h.close(); h.assert([...start, S, S + '/workers'], 1);
		h.go(-1); h.assert([...start, S, S + '/workers'], 0);
	});
	test('W3: backend drilldown has real parents at every width', () => {
		const h = new BrowserHistory();
		const paths = ['/settings', '/settings/backends', '/settings/backends/sample', '/settings/backends/sample/accounts'];
		for (let index = 0; index < paths.length; index++) { h.move(paths[index]!); h.assert([...start, ...paths.slice(0, index + 1)]); }
		h.up(paths[2]!); h.assert([...start, ...paths], 4);
		h.up(paths[1]!); h.assert([...start, ...paths], 3);
		h.up(paths[0]!); h.assert([...start, ...paths], 2);
	});
	test('W4: cross-tree repair Back returns to project MCP; Close still returns to chat', () => {
		const h = new BrowserHistory(); const projectMcp = S + '/mcp'; const backendMcp = '/settings/backends/sample/mcp';
		h.move(projectMcp); h.assert([...start, projectMcp]);
		h.move(backendMcp); h.assert([...start, projectMcp, backendMcp]);
		h.go(-1); h.assert([...start, projectMcp, backendMcp], 2);
		h.go(1); h.assert([...start, projectMcp, backendMcp], 3);
		h.close(); h.assert([...start, projectMcp, backendMcp], 1);
	});
	test('W5 + Usage: shallow overlay Back/Close dismiss first; login detour Back reopens Usage', () => {
		const h = new BrowserHistory(); h.move('/settings'); h.assert([...start, '/settings']);
		h.move('/settings', false, 'usage'); h.assert([...start, '/settings', '/settings [usage]']);
		h.go(-1); h.assert([...start, '/settings', '/settings [usage]'], 2);
		h.go(1); h.assert([...start, '/settings', '/settings [usage]'], 3);
		h.move('/settings/backends/sample/accounts'); h.assert([...start, '/settings', '/settings [usage]', '/settings/backends/sample/accounts']);
		h.go(-1); h.assert([...start, '/settings', '/settings [usage]', '/settings/backends/sample/accounts'], 3);
		h.go(-1); h.assert([...start, '/settings', '/settings [usage]', '/settings/backends/sample/accounts'], 2);
		h.move('/usage'); h.assert([...start, '/settings', '/usage']);
		h.close(); h.assert([...start, '/settings', '/usage'], 1);
	});
	test('W6: resize does not change the entry or select a section', () => {
		const h = new BrowserHistory(); h.move(S); h.assert([...start, S]);
		for (const width of [390, 1440, 390]) { void width; h.assert([...start, S]); }
	});
	test('MCP detour: selected, catalogue/preset, import and command review are shallow children', () => {
		const h = new BrowserHistory(); const path = '/settings/backends/sample/mcp';
		h.move(path); h.assert([...start, path]);
		h.move(path, false, 'server:sample'); h.assert([...start, path, path + ' [server:sample]']);
		h.go(-1); h.assert([...start, path, path + ' [server:sample]'], 2);
		h.move(path, false, 'add'); h.assert([...start, path, path + ' [add]']);
		h.move(path, false, 'preset:sample'); h.assert([...start, path, path + ' [add]', path + ' [preset:sample]']);
		h.go(-1); h.assert([...start, path, path + ' [add]', path + ' [preset:sample]'], 3);
		h.go(-1); h.assert([...start, path, path + ' [add]', path + ' [preset:sample]'], 2);
		h.move(path, false, 'import'); h.assert([...start, path, path + ' [import]']);
		h.move(path, false, 'review'); h.assert([...start, path, path + ' [import]', path + ' [review]']);
		h.move(path, false, 'command'); h.assert([...start, path, path + ' [import]', path + ' [review]', path + ' [command]']);
		h.go(-1); h.assert([...start, path, path + ' [import]', path + ' [review]', path + ' [command]'], 4);
		h.close(); h.assert([...start, path, path + ' [import]', path + ' [review]', path + ' [command]'], 1);
	});
	test('cold deep link Up replaces; reload preserves a visit; Close uses the scope fallback', () => {
		const h = new BrowserHistory(['/settings/backends/sample/accounts']);
		h.current.navigation.visit = { id: 'cold', entries: [] };
		h.up('/settings/backends/sample'); h.assert(['/settings/backends/sample']);
		h.close(); h.assert(['/']);
		const project = new BrowserHistory([S + '/skills']); project.close('/b/sample/projects/garden'); project.assert(['/b/sample/projects/garden']);
		const alias = new BrowserHistory([S + '#schedule-sample']);
		alias.move(S + '/schedules#schedule-sample', true); alias.assert([S + '/schedules#schedule-sample']);
		alias.move(S + '/skills'); alias.assert([S + '/schedules#schedule-sample', S + '/skills']);
		expect(alias.current.navigation.visit?.originHref).toBeUndefined();
		alias.close('/b/sample/projects/garden'); alias.assert([S + '/schedules#schedule-sample', '/b/sample/projects/garden']);
		const warm = new BrowserHistory(); warm.move(S); warm.assert([...start, S]);
		warm.current.navigation = JSON.parse(JSON.stringify(warm.current.navigation));
		warm.close(); warm.assert([...start, S], 1);
	});
	test('cold Usage closes by replacement; a new visit after Back truncates the old forward trail', () => {
		const cold = new BrowserHistory(['/usage']); cold.close(); cold.assert(['/']);
		const h = new BrowserHistory(); h.move(S); h.assert([...start, S]);
		h.move(S + '/skills'); h.assert([...start, S, S + '/skills']);
		h.close(); h.assert([...start, S, S + '/skills'], 1);
		h.move('/settings'); h.assert([...start, '/settings']);
		expect(h.current.navigation.visit?.originHref).toBe(chat);
		expect(h.current.navigation.visit?.entries).toEqual([]);
	});
	test('PWA and terminal: in-app Back follows real history, Close restores worker/task origin', () => {
		const h = new BrowserHistory(['/previous', '/b/sample/projects/garden?worker=sample#task-T1']);
		const launch = h.current.href; h.move('/b/sample/terminal?project=garden&worker=sample');
		h.assert(['/previous', launch, '/b/sample/terminal?project=garden&worker=sample']);
		expect(inAppBackVisible(h.current.navigation)).toBe(true);
		h.go(-1); h.assert(['/previous', launch, '/b/sample/terminal?project=garden&worker=sample'], 1);
		h.go(1); h.assert(['/previous', launch, '/b/sample/terminal?project=garden&worker=sample']);
		h.close(); h.assert(['/previous', launch, '/b/sample/terminal?project=garden&worker=sample'], 1);
	});
});
