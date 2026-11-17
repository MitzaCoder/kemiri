import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { graphMascotModule } from './lib/graph-mascot.ts';
import { graphMascotSvg } from '../apps/web/src/lib/generated/graph-mascot.ts';
const read = (path: string) => readFile(resolve(import.meta.dir, "..", path), "utf8");

test('generated graph mascot and shared motion CSS are current', async () => {
	expect(await read('apps/web/src/lib/generated/graph-mascot.ts')).toBe(graphMascotModule(await read('assets/brand/logo.svg')));
	expect(await read('apps/web/src/lib/components/mascot-motion.css')).toBe(await read('assets/brand/mascot-motion.css'));
});

test('graph geometry retains every master contour with one external set of gradients', async () => {
	const master = await read('assets/brand/logo.svg');
	const svg = graphMascotSvg('test-graph');
	const paths = (source: string) => [...source.matchAll(/ d="([^"]+)"/g)].map(match => match[1]);
	const original = paths(master);
	const grouped = paths(svg.geometry);
	expect(grouped.slice(0, 5)).toEqual(original.slice(0, 5));
	expect(grouped.slice(5).join('')).toBe(original[5]!);
	expect(svg.geometry).not.toMatch(/<defs|<linearGradient|\bid=/);
	expect(svg.definitions.match(/<linearGradient/g)).toHaveLength(4);
	for (const reference of svg.geometry.matchAll(/url\(#([^)]*)\)/g)) expect(svg.definitions).toContain(`id="${reference[1]}"`);
	expect(graphMascotSvg('other-graph').definitions).not.toContain('test-graph');
	expect(() => graphMascotSvg('bad"prefix')).toThrow('SVG ID prefix');
});

test("reviewed candlenut masters stay lightweight, transparent vectors", async () => {
	for (const name of ["logo.svg", "logo-mark-mono.svg"]) {
		const svg = await read(`assets/brand/${name}`);
		expect(Buffer.byteLength(svg)).toBeLessThan(4096);
		expect(svg).toContain('viewBox="260 165 504 695"');
		expect(svg).not.toMatch(/<image|data:|<filter|<rect/);
		expect(svg).toContain("<path");
	}
	const mono = await read("assets/brand/logo-mark-mono.svg");
	expect(mono).toContain('fill="currentColor" fill-rule="evenodd"');
	expect(mono).not.toContain("Gradient");
	// The two eye contours and smile are true cutouts, not painted dark features.
	for (const contour of ["M453 592", "ZM633 592", "ZM485 626"]) expect(mono).toContain(contour);
});
