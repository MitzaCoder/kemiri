import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { sanitizeReportSectionView } from '../src/lib/report-section-sanitizer.js';
import { fetchReportSectionView, SECTION_VIEW_BYTES, SECTION_VIEW_CSP, SECTION_VIEW_FRAME_POLICY, sectionViewDocument } from '../src/lib/report-section-view.js';

const dom = new JSDOM();
const theme = { mode: 'dark', tokens: { 'tone-bg': 'black', 'not-a-token': 'purple' } } as const;
const sanitize = (source: string) => sanitizeReportSectionView(source, dom.window);
const parseView = (source: string) => new JSDOM(sectionViewDocument(sanitize(source), theme)).window.document;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf2UAAAAASUVORK5CYII=';

describe('report section HTML', () => {
	test('keeps semantic content, static SVG, raster images, local links, and safe CSS', () => {
		const view = parseView(`<style>@media print{th{color:black}}</style><h1 id="table">Comparison</h1><table><tr><th scope="row">First</th><td>10</td></tr></table>
			<a href="#table">Heading</a><img src="${png}" alt="Sample"><svg role="img" aria-label="Dot"><circle cx="5" cy="5" r="1" fill="currentColor"/></svg>
			<p style="color:var(--tone-fg); background-image:url('${png}')">Summary</p>`);
		expect(view.querySelector('th')?.outerHTML).toBe('<th scope="row">First</th>');
		expect(view.querySelector('circle')?.getAttribute('fill')).toBe('currentColor');
		expect(view.querySelector('a')?.getAttribute('href')).toBe('about:srcdoc#table');
		expect(view.querySelector('img')?.getAttribute('src')).toBe(png);
		expect(view.querySelector('p')?.getAttribute('style')).toContain(png);
		expect(view.querySelector('style + style')?.textContent).toContain('@media print');
		expect(view.head.firstElementChild?.getAttribute('content')).toBe(SECTION_VIEW_CSP);
		expect(view.documentElement.dataset.theme).toBe('dark');
		expect(view.querySelector('style')?.textContent).toContain('--tone-bg:black');
		expect(view.querySelector('style')?.textContent).not.toContain('not-a-token');
	});

	test('removes active HTML, navigation, active SVG, and fetching CSS', () => {
		const view = parseView(`<base href="https://example.test/"><meta http-equiv=refresh content="0;url=https://example.test">
			<style>@import "https://example.test/import.css";p{color:red;background:url(https://example.test/image)}</style>
			<h1 onclick="test()">Native comparison</h1><script>test()</script><iframe src="https://example.test"></iframe><object></object><embed>
			<form action="https://example.test"><input><button>Send</button></form><a href="jav&#x61;script:test()">JS</a><a href="//example.test" target="_top" ping="https://example.test">Out</a>
			<img src="https://example.test/a.png" srcset="https://example.test/b.png" onerror="test()"><img src="data:image/svg+xml;base64,AAAA">
			<svg><script>test()</script><foreignObject><p>Foreign</p></foreignObject><animate href="#dot"/><use href="https://example.test/map.svg#dot"/>
			<circle id="dot" fill="url(https://example.test/dot)" style="width:expression(test());color:blue"></circle></svg>`);
		expect(view.querySelector('script, iframe, object, embed, form, input, button, base, meta[http-equiv="refresh"], foreignObject, animate, use')).toBeNull();
		expect(view.documentElement.outerHTML).not.toMatch(/example\.test|javascript:|expression\(|@import|\bonerror=|\bonclick=|\bping=|\bsrcset=|\btarget=|data:image\/svg/);
		expect(view.querySelector('circle')?.getAttribute('style')).toBe('color:blue;');
		expect(view.querySelector('style + style')?.textContent).toBe('p{color:red;}');
	});

	test('does not revive malformed foreign or raw text markup on reparse', () => {
		const view = parseView(`<p>Report</p><math><mtext><table><mglyph><style><!--</style><img title="--><img src=https://example.test/malformed onerror=test()>">
			<svg><style>&lt;/style&gt;&lt;img src=https://example.test/style onerror=test()&gt;</style></svg>
			<p style="background:u\\72l(https://example.test/escaped);background-image:image-set('https://example.test/set' 1x)">Text</p>`);
		expect(view.querySelector('script, img[src], iframe, [onerror]')).toBeNull();
		expect(Array.from(view.querySelectorAll('style')).map(style => style.textContent).join('')).not.toContain('example.test');
	});

	test('rejects the whole view at byte, element, depth and raster limits', () => {
		expect(() => sanitize('é'.repeat(SECTION_VIEW_BYTES / 2 + 1))).toThrow();
		expect(() => sanitize('<p>Text</p>'.repeat(2001))).toThrow();
		expect(() => sanitize('<div>'.repeat(33) + 'Text' + '</div>'.repeat(33))).toThrow();
		const bytes = Buffer.from(png.split(',')[1]!, 'base64');
		bytes.writeUInt32BE(2049, 16);
		expect(() => sanitize(`<p>Text</p><img src="data:image/png;base64,${bytes.toString('base64')}">`)).toThrow();
		expect(() => sanitize('<script>Nothing readable</script>')).toThrow();
	});
});

describe('pinned section fetch and frame', () => {
	const view = { artifactId: 'comparison', version: 2, label: 'Open comparison table' };
	const html = '<h1>Comparison</h1>';
	const mime = { 'Content-Type': 'text/html; charset=UTF-8' };
	const client = { readArtifactUrl: async (project: string, id: string) => {
		expect([project, id]).toEqual(['linden', 'comparison~2']);
		return { url: 'http://example.test/artifacts/comparison~2', expiresAt: '' };
	} };
	const load = (respond: () => Response) => fetchReportSectionView(client, 'linden', view, 'http://localhost:5364', new AbortController().signal,
		((input, init) => {
			expect(String(input)).toEndWith('/artifacts/comparison~2');
			expect(new Headers(init?.headers).get('Range')).toBe(`bytes=0-${SECTION_VIEW_BYTES}`);
			return Promise.resolve(respond());
		}) as typeof fetch);

	test('asks for the exact pin and reads only a complete UTF-8 HTML response', async () => {
		expect(await load(() => new Response(html, { status: 206, headers: { ...mime, 'Content-Range': `bytes 0-${html.length - 1}/${html.length}` } }))).toBe(html);
		await expect(load(() => new Response(null, { status: 404 }))).rejects.toThrow();
		await expect(load(() => new Response(html, { status: 206, headers: mime }))).rejects.toThrow();
		await expect(load(() => new Response(html, { status: 206, headers: { ...mime, 'Content-Range': `bytes 0-${html.length - 1}/${html.length + 1}` } }))).rejects.toThrow();
		await expect(load(() => new Response('é'.repeat(SECTION_VIEW_BYTES), { headers: mime }))).rejects.toThrow();
		await expect(load(() => new Response(new Uint8Array([0xff]), { headers: mime }))).rejects.toThrow();
	});

	test('both sizes share the strict srcdoc frame and failures do not replace the native section', async () => {
		expect(SECTION_VIEW_FRAME_POLICY).toEqual({ sandbox: '', referrerpolicy: 'no-referrer' });
		const component = await Bun.file(new URL('../src/lib/components/ReportSectionView.svelte', import.meta.url)).text();
		expect(component.match(/<iframe\b[^>]+>/g)).toEqual([
			'<iframe {...SECTION_VIEW_FRAME_POLICY} srcdoc={frameDocument} title={`${view.label} (HTML view)`}\n\t\tclass:roomy tabindex="0">',
		]);
		expect(component).toContain('{@render frame(srcdoc, false)}');
		expect(component).toContain('{@render frame(srcdoc, true)}');
		expect(component).toContain('View unavailable');
		const section = await Bun.file(new URL('../src/lib/components/ReportSection.svelte', import.meta.url)).text();
		expect(section).toMatch(/<ReportSectionBody[^>]+\/\s*>\s*\{\/if\}\s*\{#if artifactConnection\?\.reportSectionViews/);
	});
});
