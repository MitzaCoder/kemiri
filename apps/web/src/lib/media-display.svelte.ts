/** The gallery's compare/single choice, shared across projects on this device. */
const STORAGE_KEY = 'aiki.media-separate.v1';

function loadSeparate(): boolean {
	try { return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === 'true'; }
	catch { return false; }
}

class MediaDisplay {
	separate = $state(loadSeparate());

	setSeparate(separate: boolean): void {
		this.separate = separate;
		try { localStorage.setItem(STORAGE_KEY, String(separate)); } catch { /* Keep the in-memory choice. */ }
	}
}

export const mediaDisplay = new MediaDisplay();
