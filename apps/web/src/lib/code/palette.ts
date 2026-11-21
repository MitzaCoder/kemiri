/** Catppuccin, paired by token family. Keep light text legible against white. */
const catppuccinTokens = {
	text: ['#4c4f69', '#cdd6f4'], comment: ['#8c8fa1', '#9399b2'],
	keyword: ['#8839ef', '#cba6f7'], string: ['#40a02b', '#a6e3a1'],
	number: ['#fe640b', '#fab387'], function: ['#1e66f5', '#89b4fa'],
	type: ['#df8e1d', '#f9e2af'], property: ['#179299', '#94e2d5'],
	operator: ['#04a5e5', '#89dceb'], constant: ['#d20f39', '#f38ba8'],
	tag: ['#1e66f5', '#89b4fa'], attribute: ['#df8e1d', '#f9e2af'],
	punctuation: ['#7c7f93', '#a6adc8'], heading: ['#ea76cb', '#f5c2e7'],
} as const;

export function contrastAgainstWhite(hex: string): number {
	const [r, g, b] = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
		.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) as [number, number, number];
	return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

/** Keep hue/saturation and lower the original HSL lightness by whole percentage points. */
export function darkenLatteToken(hex: string): string {
	if (!/^#[\da-f]{6}$/i.test(hex) || contrastAgainstWhite(hex) >= 4.5) return hex;
	const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
	const high = Math.max(...rgb), low = Math.min(...rgb);
	const lightness = (high + low) / 2;
	const chroma = high - low;
	const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
	// Relative channels hold HSL hue constant, without a hue angle or rounding between steps.
	const hueChannels = rgb.map(channel => chroma === 0 ? 0 : (channel - lightness) / chroma);
	for (let step = 1; step <= 100; step++) {
		const light = Math.max(0, lightness - step / 100);
		const nextChroma = saturation * (1 - Math.abs(2 * light - 1));
		const next = '#' + hueChannels.map(channel => Math.round(255 * (light + nextChroma * channel)).toString(16).padStart(2, '0')).join('');
		if (contrastAgainstWhite(next) >= 4.5) return next;
	}
	return '#000000';
}

export function codeTokenVariables(dark: boolean): Record<string, string> {
	return Object.fromEntries(Object.entries(catppuccinTokens).map(([token, [latte, mocha]]) =>
		[`--code-${token}`, dark ? mocha : darkenLatteToken(latte)]));
}
