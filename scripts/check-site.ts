#!/usr/bin/env bun
/** Local link/asset/fragment checks for pages and stylesheets. No network, dependencies or build needed. */
import { resolve, sep } from 'node:path';

export async function checkSite(root = resolve(import.meta.dir, '../site')): Promise<number> {
	const pages = [...new Bun.Glob('**/*.html').scanSync(root)];
	let checked = 0;
	for (const page of pages) {
		const html = await Bun.file(resolve(root, page)).text();
		if (!/^<!doctype html>/i.test(html) || !/<html lang="en">/.test(html) || !/<title>[^<]+<\/title>/.test(html)) throw new Error(`Missing document metadata: ${page}`);
		if (!html.includes('Kemiri') || !html.includes('https://kemiri.dev/')) throw new Error(`Missing Kemiri identity: ${page}`);
		if (/aikilabs\.dev|github\.com\/MitzaCoder\/aiki(?:[\/"#]|$)|support@aikilabs/.test(html)) throw new Error(`Stale public identity: ${page}`);
		// Everything a page loads comes from the site itself; only links a visitor follows may leave it.
		for (const [tag] of html.matchAll(/<(?:script|img|source|link)\b[^>]*>/g)) {
			if (/(?:src|srcset|href)="https?:/.test(tag) && !/^<link rel="canonical"/.test(tag)) throw new Error(`External resource: ${page}: ${tag}`);
		}
		for (const [, reference] of html.matchAll(/(?:href|src|srcset)="([^"]+)"/g)) {
			if (!reference) continue;
			checked++;
			if (/^(https:\/\/|mailto:)/.test(reference)) continue;
			if (/^[a-z]+:|^\/\//i.test(reference)) throw new Error(`Unexpected URL: ${page}: ${reference}`);
			const [path = '', fragment] = reference.split('#');
			let target = path ? resolve(root, path.startsWith('/') ? `.${path}` : `${page.slice(0, page.lastIndexOf('/') + 1)}${path}`) : resolve(root, page);
			if (target !== root && !target.startsWith(root + sep)) throw new Error(`Link escapes site: ${reference}`);
			if (!path || path.endsWith('/')) target = path ? resolve(target, 'index.html') : target;
			if (!await Bun.file(target).exists()) throw new Error(`Missing target: ${page}: ${reference}`);
			if (fragment && !(await Bun.file(target).text()).includes(`id="${fragment}"`)) throw new Error(`Missing fragment: ${page}: ${reference}`);
		}
	}
	for (const sheet of new Bun.Glob('**/*.css').scanSync(root)) {
		for (const [, reference = ''] of (await Bun.file(resolve(root, sheet)).text()).matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)) {
			checked++;
			if (!reference.startsWith('/') || reference.startsWith('//')) throw new Error(`Stylesheet resource is not a site path: ${sheet}: ${reference}`);
			const target = resolve(root, `.${reference}`);
			if (!target.startsWith(root + sep) || !await Bun.file(target).exists()) throw new Error(`Missing target: ${sheet}: ${reference}`);
		}
	}
	if (pages.length < 2) throw new Error('Homepage and privacy page required');
	if ((await Bun.file(resolve(root, 'CNAME')).text()).trim() !== 'kemiri.dev') throw new Error('Wrong custom domain');
	console.log(`Site check: ${pages.length} HTML pages, ${checked} links/assets/fragments OK.`);
	return checked;
}
if (import.meta.main) await checkSite();
