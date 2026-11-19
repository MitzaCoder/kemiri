export const COLOR_SCHEME_STORAGE_KEY = 'aiki.color-scheme.v1';
export type ColorSchemePreference = 'device' | 'light' | 'dark';

export function parseColorScheme(stored: unknown): ColorSchemePreference {
	return stored === 'light' || stored === 'dark' ? stored : 'device';
}

export function isDarkScheme(preference: ColorSchemePreference, deviceDark: boolean): boolean {
	return preference === 'dark' || (preference === 'device' && deviceDark);
}
