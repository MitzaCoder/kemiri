export const CODE_VIEW_BYTES = 1024 * 1024;
export const CODE_VIEW_LINES = 20_000;

export function fitsCodeView(text: string): boolean {
	if (text.length > CODE_VIEW_BYTES || new TextEncoder().encode(text).length > CODE_VIEW_BYTES || text.includes('\0')) return false;
	let lines = 1;
	for (const _ of text.matchAll(/\r\n?|\n/g)) if (++lines > CODE_VIEW_LINES) return false;
	return true;
}
