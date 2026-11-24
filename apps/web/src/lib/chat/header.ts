/** Responsive layout follows the chat pane, not the viewport: a docked panel takes room from the chat. */
export type HeaderActionWidth = {
	label?: string;
	/** A count costs room beside a label, but not in an icon's corner. */
	badge?: boolean;
	placement?: 'persistent' | 'more';
};

export type HeaderLayout = 'labels' | 'icons' | 'menu';

/** Keep room for the coordinator mark, status, chevron and about 135px of name. */
const TITLE_WIDTH = 190;
const ACTION_GAP = 4;
const ICON_WIDTH = 32;
const LABEL_CHROME_WIDTH = 44;
const LABEL_CHARACTER_WIDTH = 7.2;
const INLINE_BADGE_WIDTH = 24;

/** Keep at least 112px for the title beside Apps, More and Panel in a cramped row. */
export function headerHasRoomForApps(available: number, fixedWidth: number): boolean {
	return available - fixedWidth >= 112 + 3 * (ICON_WIDTH + ACTION_GAP);
}

/** `fixedWidth` includes the gaps after controls outside the action list, such as the projects drawer. */
export function headerLayout(available: number, actions: readonly HeaderActionWidth[], fixedWidth = 0): HeaderLayout {
	const inline = actions.filter(action => action.placement !== 'more');
	// More is always visible. Count one gap per control, including the gap next to the title.
	const room = available - TITLE_WIDTH - fixedWidth - ICON_WIDTH - ACTION_GAP;
	const labelled = inline.reduce((sum, action) => sum + ACTION_GAP + (action.label === undefined
		? ICON_WIDTH : LABEL_CHROME_WIDTH + action.label.length * LABEL_CHARACTER_WIDTH + (action.badge ? INLINE_BADGE_WIDTH : 0)), 0);
	if (labelled <= room) return 'labels';
	return inline.length * (ICON_WIDTH + ACTION_GAP) <= room ? 'icons' : 'menu';
}

/** Panel and the active apps button stay available even when the three tools fold away. */
export function visibleHeaderActions<T extends HeaderActionWidth>(layout: HeaderLayout, actions: readonly T[]): { inline: T[]; menu: T[] } {
	const inline: T[] = [];
	const menu: T[] = [];
	for (const action of actions) {
		const inMenu = action.placement === 'more' || (layout === 'menu' && action.placement !== 'persistent');
		(inMenu ? menu : inline).push(action);
	}
	return { inline, menu };
}
