import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const read = (path: string) => readFile(resolve(import.meta.dir, "..", path), "utf8");

test("motion derivative preserves every static master contour", async () => {
	const master = await read("assets/brand/logo.svg");
	const motion = await read("assets/brand/mascot-motion.svg");
	const paths = (svg: string) => [...svg.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]!);
	const original = paths(master);
	const grouped = paths(motion);
	expect(grouped.slice(0, 5)).toEqual(original.slice(0, 5));
	expect(grouped.slice(5).join("")).toBe(original[5]!);
	for (const part of ["mascot-pose", "mascot-leaf", "mascot-body", "mascot-eye-left", "mascot-eye-right", "mascot-mouth"]) expect(motion).toMatch(new RegExp(`class="[^"]*${part}`));
});

test("preview is self-contained with both surfaces, every size and accessible controls", async () => {
	const html = await read("assets/brand/previews/mascot-animations.html");
	expect(html).toStartWith("<!doctype html>");
	expect(html).not.toMatch(/{{[A-Z_]+}}|<(?:img|script|link)[^>]+(?:src|href)=|<image|data:image/);
	expect(html).toContain('id="pause" aria-pressed="false"');
	expect(html).toContain("Replay B · Done");
	for (const state of ["working", "done", "thinking", "sleeping", "failed"]) {
		for (const size of [24, 32, 128]) expect(html.match(new RegExp(`data-state="${state}"[^>]*--size:${size}px`, "g"))?.length).toBe(2);
		expect(html.match(new RegExp(`data-state="${state}"[^>]*--size:26px`, "g"))?.length).toBe(2);
	}
	const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
	expect(new Set(ids).size).toBe(ids.length);
});

test('sleep and failure preserve still poses, use finite failure and transform/opacity only', async () => {
	const css = await read('assets/brand/mascot-motion.css');
	const html = await read('assets/brand/previews/mascot-animations.html');
	expect(css).toContain('kemiri-sleep 6s ease-in-out infinite');
	expect(css).toContain('kemiri-sleep-z 6s ease-in-out infinite');
	expect(css).toContain('kemiri-shake .5s ease-in-out both');
	expect(css).toContain('scale(1.02,.98)');
	expect(css).toContain('opacity: .72');
	expect(css).toContain('rotate(-9deg) !important');
	expect(css).toContain('scaleY(-1) !important');
	expect(css).toContain('rotate(11deg) !important');
	expect(html).toContain('data-replay-failed');
	for (const size of [24, 26, 32, 128]) {
		expect(html).toMatch(new RegExp(`data-state="sleeping"[^>]*data-sleep-z="${size >= 28}"[^>]*--size:${size}px`));
	}
	for (const keyframes of css.matchAll(/@keyframes[^}]+(?:\}[^}]+)*?\n\}/g)) {
		const properties = [...keyframes[0].matchAll(/([a-z-]+):/g)].map(match => match[1]);
		expect(properties.every(property => property === 'transform' || property === 'opacity')).toBe(true);
	}
});

test("motion has calm loop timings, finite done, reduced-motion and small-size treatment", async () => {
	const css = await read("assets/brand/mascot-motion.css");
	for (const animation of ["kemiri-breathe 3s ease-in-out infinite", "kemiri-working-blink 6s ease-in-out infinite", "kemiri-look 3.5s ease-in-out infinite", "kemiri-hop 1.3s ease-in-out both"]) expect(css).toContain(animation);
	expect(css).toContain('data-size="small"');
	expect(css).toContain("prefers-reduced-motion: reduce");
	expect(css).toContain("animation: none !important; transform: none !important");
	expect(css).toContain("transform-origin: 512px 850px");
});
