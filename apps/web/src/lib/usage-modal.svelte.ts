/** Usage is a navigation-level overlay; its entry survives reload and Forward. */
import { page } from '$app/state';
import { openUsage, closeUsage } from './settings-navigation.svelte.js';
export const usageModal = {
	get open(): boolean { return page.state.usage === true || page.url.pathname === '/usage'; },
	set open(open: boolean) { if (open) openUsage(); else closeUsage(); },
};
