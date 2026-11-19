/** SvelteKit adapter; native Back/Forward is deliberately never intercepted. */
import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
import { page } from '$app/state';
import { settingsEntryRedirect } from './settings.js';
import {
	closeAction, settingsSurface, upAction, visitEntry,
	type McpNavigationView, type NavigationAction, type NavigationEntry,
} from './settings-navigation.js';

let performingNavigation = false;
const href = () => `${page.url.pathname}${page.url.search}${page.url.hash}`;
const entry = (): NavigationEntry => page.state.navigation ?? { index: 0 };

// Match the SettingsShell rail breakpoint. Read once per opening; never subscribe to resize.
const splitSettings = () => matchMedia('(min-width: 48rem)').matches;

export function installSettingsNavigation(): void {
	let nextEntry: NavigationEntry | undefined;
	beforeNavigate(navigation => {
		if (performingNavigation || navigation.type === 'popstate' || !navigation.to || navigation.willUnload) return;
		if (settingsSurface(navigation.to.url.pathname)) {
			navigation.cancel();
			queueMicrotask(() => { void navigateSettings(navigation.to!.url.href); });
		} else {
			nextEntry = { index: entry().index + 1 };
		}
	});
	afterNavigate(navigation => {
		if (!page.state.navigation) {
			const redirect = navigation.type === 'enter' && settingsEntryRedirect(page.url, splitSettings());
			if (redirect) {
				void navigateSettings(redirect, true);
				return;
			}
			const initial = nextEntry ?? { index: 0 };
			if (settingsSurface(page.url.pathname)) initial.visit = { id: crypto.randomUUID(), entries: [] };
			void writeEntryState({ ...page.state, navigation: initial }, true);
		}
		nextEntry = undefined;
	});
}

export async function navigateSettings(to: string, replace = false): Promise<void> {
	const url = new URL(to, page.url.href);
	// On an in-app opening, write the final section into the new entry directly (push + replace in one step).
	// Up and Back use separate paths, so an index they reveal is never resolved again.
	const target = url.origin === page.url.origin ? settingsEntryRedirect(url, splitSettings()) ?? to : to;
	const navigation = visitEntry(entry(), href(), page.url.origin, crypto.randomUUID(), replace,
		settingsSurface(page.url.pathname) || page.state.usage === true);
	performingNavigation = true;
	try {
		await goto(target, { replace, persistState: true, state: { navigation } });
	} finally { performingNavigation = false; }
}

export function performSettingsAction(action: NavigationAction): void {
	if (action.type === 'pop') { history.go(-action.count); return; }
	performingNavigation = true;
	void goto(action.href, { replace: true, persistState: true, state: {
		navigation: settingsSurface(new URL(action.href, page.url.href).pathname) ? entry() : { index: entry().index },
	} }).finally(() => { performingNavigation = false; });
}
export function settingsUp(parent: string): void { performSettingsAction(upAction(page.state.navigation, parent)); }
export function settingsClose(fallback = '/'): void {
	performSettingsAction(closeAction(page.state.navigation, fallback, page.url.origin));
}

export function openUsage(): void {
	if (page.state.usage || page.url.pathname === '/usage') return;
	void writeEntryState({ ...page.state, navigation: visitEntry(entry(), href(), page.url.origin, crypto.randomUUID(), false,
		settingsSurface(page.url.pathname)), usage: true }, false);
}
export function closeUsage(): void {
	if (page.state.usage) history.back();
	else if (page.url.pathname === '/usage') settingsClose('/');
}

/** Only identifiers and view names are persisted. All editor values remain in the component. */
export function pushMcpView(mcp: McpNavigationView): void {
	void writeEntryState({ ...page.state, navigation: visitEntry(entry(), href(), page.url.origin, crypto.randomUUID()), mcp: { listIndex: page.state.mcp?.listIndex ?? entry().index, ...mcp } }, false);
}
export function replaceMcpView(mcp: McpNavigationView): void { void writeEntryState({ ...page.state, mcp: { listIndex: page.state.mcp?.listIndex, ...mcp } }, true); }
export function popMcpView(): void { history.back(); }
export function mcpListUp(): void {
	const count = entry().index - (page.state.mcp?.listIndex ?? entry().index);
	if (count > 0) history.go(-count);
	else replaceMcpView({});
}

/** Current SvelteKit requires persistState even for shallow entries to survive reload. */
async function writeEntryState(state: App.PageState, replace: boolean): Promise<void> {
	performingNavigation = true;
	try { await goto(page.url.href, { shallow: true, replace, persistState: true, state }); }
	finally { performingNavigation = false; }
}
