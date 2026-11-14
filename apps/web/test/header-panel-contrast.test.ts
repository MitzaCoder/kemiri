import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/lib/components/ProjectChat.svelte", import.meta.url), "utf8");
const css = source.slice(source.indexOf("<style>"));
function contrast(a: string, b: string): number {
	const luminance = (hex: string) => {
		const channels = hex.slice(1).match(/../g)!.map(channel => {
			const value = Number.parseInt(channel, 16) / 255;
			return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
		});
		return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
	};
	const x = luminance(a), y = luminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function pair(selector: string, property: string): string[] {
	const start = css.indexOf(selector);
	expect(start).toBeGreaterThanOrEqual(0);
	const rule = css.slice(start, css.indexOf("}", start));
	return rule.match(new RegExp(`${property}: light-dark\\((#[a-f0-9]+), (#[a-f0-9]+)\\)`))!.slice(1);
}

for (const prefix of ["", "[data-theme='neutral'] "]) {
	test(`${prefix || "Jarvis "}selected panel text and hover meet AA in both modes`, () => {
		const selector = `:global(${prefix}.header-panel-action[aria-pressed='true'])`;
		const foreground = pair(selector, "color");
		const background = pair(selector, "background");
		const hover = pair(`:global(${prefix}.header-panel-action[aria-pressed='true']:hover)`, "background");
		for (let mode = 0; mode < 2; mode++) {
			expect(contrast(foreground[mode]!, background[mode]!)).toBeGreaterThanOrEqual(4.5);
			expect(contrast(foreground[mode]!, hover[mode]!)).toBeGreaterThanOrEqual(4.5);
			expect(hover[mode]).not.toBe(background[mode]);
		}
	});
}

test("badge labels meet AA independently of the selected panel", () => {
	const foreground = pair(":global(.header-panel-badge)", "color");
	const background = pair(":global(.header-panel-badge)", "background");
	for (let mode = 0; mode < 2; mode++) expect(contrast(foreground[mode]!, background[mode]!)).toBeGreaterThanOrEqual(4.5);
});

test("inline and overflow actions share panel-only styling and retain pressed semantics", () => {
	const actions = source.slice(source.indexOf("{#snippet headerButton"), source.indexOf('<div class="flex h-full'));
	expect(actions.match(/action.kind === 'tab' \? 'header-panel-action'/g)).toHaveLength(2);
	expect(actions.match(/aria-pressed=\{action.pressed\}/g)).toHaveLength(2);
	expect(actions).not.toContain("text-(--chat-fg-subtle)");
	expect(css).not.toContain("outline: none");
});
