import { COLOR_SCHEME_STORAGE_KEY, isDarkScheme, parseColorScheme, type ColorSchemePreference } from './color-scheme.ts';

class ColorScheme {
	preference = $state<ColorSchemePreference>('device');

	constructor() {
		if (typeof document === 'undefined') return;
		// app.html reads storage and sets this before the first paint.
		this.preference = parseColorScheme(document.documentElement.dataset.colorScheme);
		window.addEventListener('storage', (event) => {
			if (event.key === COLOR_SCHEME_STORAGE_KEY) this.apply(parseColorScheme(event.newValue));
		});
	}

	private apply(preference: ColorSchemePreference): void {
		this.preference = preference;
		const root = document.documentElement;
		root.dataset.colorScheme = preference;
		root.classList.toggle('dark', isDarkScheme(preference, matchMedia('(prefers-color-scheme: dark)').matches));
	}

	set(preference: ColorSchemePreference): void {
		this.apply(preference);
		try { localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, preference); } catch { /* Keep the in-memory choice. */ }
	}
}

export const colorScheme = new ColorScheme();
