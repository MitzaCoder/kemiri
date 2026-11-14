/** Settings history policy. Plain serializable metadata only; never form values or credentials. */
export type SettingsVisit = {
	id: string;
	originHref?: string;
	originIndex?: number;
	/** Earlier entries in this visit, not a guess based on browser history.length. */
	entries: { href: string; index: number }[];
};
export type NavigationEntry = { index: number; visit?: SettingsVisit };
export type NavigationAction = { type: 'pop'; count: number } | { type: 'replace'; href: string };
export type McpNavigationView = {
	selectedId?: string;
	listIndex?: number;
	view?: 'add' | 'import' | 'import-review' | 'command';
	presetId?: string;
	editing?: string;
	commandFrom?: 'add' | 'import';
};

/** Accept only this origin's local paths, retaining the exact query and fragment. */
export function localHref(href: string, origin: string): string | undefined {
	try {
		if (/[\\\u0000-\u0020]/.test(href)) return undefined;
		const url = new URL(href, origin);
		if (url.origin !== origin || url.username || url.password) return undefined;
		if (!href.startsWith('/') && !href.startsWith(`${origin}/`)) return undefined;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch { return undefined; }
}

export function settingsSurface(pathname: string): boolean {
	return /^\/settings(?:\/|$)/.test(pathname) || /^\/b\/[^/]+\/projects\/[^/]+\/settings(?:\/|$)/.test(pathname)
		|| /^\/b\/[^/]+\/terminal$/.test(pathname) || pathname === '/usage' || pathname === '/notifications';
}

export function visitEntry(
	current: NavigationEntry,
	currentHref: string,
	origin: string,
	visitId: string,
	replace = false,
	continueVisit = true,
): NavigationEntry {
	const visit = continueVisit ? current.visit : undefined;
	return {
		index: current.index + (replace ? 0 : 1),
		visit: {
			id: visit?.id ?? visitId,
			...(visit ? { originHref: visit.originHref, originIndex: visit.originIndex } : {
				originHref: replace ? undefined : localHref(currentHref, origin), originIndex: replace ? undefined : current.index,
			}),
			entries: [...(visit?.entries ?? []), ...(!replace && visit ? [{ href: currentHref, index: current.index }] : [])],
		},
	};
}

export function upAction(entry: NavigationEntry | undefined, parent: string): NavigationAction {
	const previous = entry?.visit?.entries.findLast(item => item.href.split(/[?#]/)[0] === parent);
	if (entry && previous && previous.index < entry.index) return { type: 'pop', count: entry.index - previous.index };
	return { type: 'replace', href: parent };
}

export function closeAction(entry: NavigationEntry | undefined, fallback: string, origin: string): NavigationAction {
	const visit = entry?.visit;
	const href = visit?.originHref && localHref(visit.originHref, origin);
	if (entry && href && visit?.originIndex !== undefined && visit.originIndex >= 0 && visit.originIndex < entry.index) {
		return { type: 'pop', count: entry.index - visit.originIndex };
	}
	return { type: 'replace', href: fallback };
}

export function inAppBackVisible(entry: NavigationEntry | undefined): boolean {
	return entry !== undefined && entry.index > 0;
}

export function sectionNavigation(
	activeSection: string | undefined,
	currentPath?: string,
	targetHref?: string,
): 'push' | 'replace' | 'up' | 'stay' {
	if (currentPath && targetHref) {
		if (currentPath === targetHref) return 'stay';
		if (currentPath.startsWith(`${targetHref}/`)) return 'up';
	}
	return activeSection === undefined ? 'push' : 'replace';
}
