import createDOMPurify from 'dompurify';
import { generate, parse, walk, type CssNode } from 'css-tree';
import { imageSize } from 'image-size';
import { SECTION_VIEW_BYTES, type SanitizedSectionView } from './report-section-view.js';

const HTML_TAGS = 'html head body style a abbr address article aside b blockquote br caption cite code col colgroup dd del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li main mark ol p pre q s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr';
const SVG_TAGS = 'svg g title desc path circle ellipse line polygon polyline rect text tspan';
const ATTRIBUTES = 'class id lang dir title role aria-label aria-hidden aria-labelledby aria-describedby style href src alt width height colspan rowspan scope headers span start reversed datetime open viewbox preserveaspectratio d points x y x1 x2 y1 y2 cx cy r rx ry transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray opacity text-anchor dominant-baseline font-size';
const SVG_PAINT = new Set(['fill', 'stroke']);
const CSS_FUNCTIONS = new Set('var calc min max clamp rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix linear-gradient radial-gradient repeating-linear-gradient repeating-radial-gradient translate translatex translatey scale rotate'.split(' '));
const MAX_RASTER_EDGE = 2048;
const MAX_RASTER_PIXELS = 4 * 1024 * 1024;

/** Detached parsing, then an allowlist. No author bytes are inserted into the application DOM. */
export function sanitizeReportSectionView(source: string, window: Parameters<typeof createDOMPurify>[0] = globalThis.window): SanitizedSectionView {
	if (new TextEncoder().encode(source).length > SECTION_VIEW_BYTES || source.includes('\0')) throw new Error('Invalid section view source');
	const purifier = createDOMPurify(window);
	let rasterPixels = 0;
	let cssNodes = 0;
	let overBudget = false;

	function allowedImage(url: string): boolean {
		const match = /^data:image\/(png|jpeg|gif|webp);base64,([a-z\d+/]+={0,2})$/i.exec(url);
		if (!match) return false;
		try {
			const bytes = Uint8Array.from(atob(match[2]!), ch => ch.charCodeAt(0));
			const { type, width, height } = imageSize(bytes);
			if ((type === 'jpg' ? 'jpeg' : type) !== match[1]!.toLowerCase() || !width || !height) return false;
			rasterPixels += width * height;
			if (width > MAX_RASTER_EDGE || height > MAX_RASTER_EDGE || rasterPixels > MAX_RASTER_PIXELS) overBudget = true;
			return !overBudget;
		} catch { return false; }
	}

	function safeCss(source: string, inline: boolean): string {
		let parsed: CssNode;
		try { parsed = parse(source, { context: inline ? 'declarationList' : 'stylesheet', parseCustomProperty: true }); }
		catch { overBudget = true; return ''; }
		walk(parsed, () => { if (++cssNodes > 10_000) overBudget = true; });
		if (overBudget) return '';
		function filter(node: CssNode, depth = 0): string {
			if (depth > 16) { overBudget = true; return ''; }
			switch (node.type) {
				case 'StyleSheet': return node.children.map(child => filter(child, depth + 1)).toArray().join('');
				case 'Block':
				case 'DeclarationList': return node.children.map(child => filter(child, depth + 1)).toArray().join('');
				case 'Atrule': {
					// Only media queries are needed for responsive and print layouts. No imports, fonts or keyframes.
					if (node.name.toLowerCase() !== 'media' || !node.block || !node.prelude || node.prelude.type === 'Raw') return '';
					return `@media ${generate(node.prelude)}{${filter(node.block, depth + 1)}}`;
				}
				case 'Rule': return node.prelude.type === 'SelectorList' ? `${generate(node.prelude)}{${filter(node.block, depth + 1)}}` : '';
				case 'Declaration': {
					if (!/^(?:--[\w-]+|[a-z][a-z-]*)$/i.test(node.property) || node.property.toLowerCase() === 'behavior') return '';
					let allowed = true;
					walk(node.value, part => {
						if (part.type === 'Raw' || (part.type === 'Function' && !CSS_FUNCTIONS.has(part.name.toLowerCase())) ||
							(part.type === 'Url' && !allowedImage(part.value))) allowed = false;
					});
					const declaration = generate(node);
					return allowed && !/[\\<]/.test(declaration) ? `${declaration};` : '';
				}
				default: return '';
			}
		}
		const css = filter(parsed);
		return css.includes('<') ? '' : css;
	}

	purifier.addHook('uponSanitizeAttribute', (element, attribute) => {
		const name = attribute.attrName;
		if (name === 'href') attribute.keepAttr = element.localName === 'a' && /^#[\w.:-]+$/.test(attribute.attrValue);
		if (name === 'src') attribute.keepAttr = element.localName === 'img' && allowedImage(attribute.attrValue);
		if (name === 'style') attribute.attrValue = safeCss(attribute.attrValue, true);
		if (SVG_PAINT.has(name)) attribute.keepAttr = /^[\w#.,%()\s+-]+$/.test(attribute.attrValue) && !/url\s*\(/i.test(attribute.attrValue);
	});
	const sanitized = purifier.sanitize(source, {
		WHOLE_DOCUMENT: true, RETURN_DOM: true, ALLOWED_TAGS: `${HTML_TAGS} ${SVG_TAGS}`.split(' '), ALLOWED_ATTR: ATTRIBUTES.split(' '),
		ALLOW_ARIA_ATTR: false, ALLOW_DATA_ATTR: false,
		ADD_FORBID_CONTENTS: ['form', 'noscript'],
	});
	if (sanitized.nodeType !== 1) throw new Error('Invalid section view');
	const root = sanitized as Element;
	const head = root.querySelector('head');
	const body = root.querySelector('body');
	if (!body?.firstElementChild && !body?.textContent?.trim()) throw new Error('Empty section view');
	const pending: [Element, number][] = [[root, 0]];
	let count = 0;
	while (pending.length) {
		const [element, depth] = pending.pop()!;
		if (++count > 2000 || depth > 32 || overBudget) throw new Error('Section view is too complex');
		if (element.localName === 'style') element.textContent = safeCss(element.textContent ?? '', false);
		// A srcdoc inherits the host base URL. Name the frame's own document explicitly for fragment links.
		if (element.localName === 'a' && element.hasAttribute('href')) element.setAttribute('href', `about:srcdoc${element.getAttribute('href')}`);
		for (const child of element.children) pending.push([child, depth + 1]);
	}
	if (overBudget) throw new Error('Section view is too complex');
	return { styles: Array.from(head?.querySelectorAll('style') ?? []).map(style => style.outerHTML).join(''), body: body!.innerHTML };
}
