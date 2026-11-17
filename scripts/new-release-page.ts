#!/usr/bin/env bun
/**
 * Starts the kemiri.dev release notes for one version: writes site/releases/TAG/index.html from
 * scripts/release-page.template.html and puts TAG first in site/releases/index.html as the latest release.
 * The text is then written by hand; `bun test scripts/site.test.ts` fails while a TODO is left.
 *
 *   bun scripts/new-release-page.ts v0.1.0-pilot.7 2026-12-01 "One line on what this release is about"
 */
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const marker = /^[ \t]*<!-- releases: newest first\..*-->\n/m;
const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function addReleasePage(options: { tag: string; date: string; headline: string; site?: string; template?: string }): Promise<string> {
	const site = options.site ?? resolve(import.meta.dir, '../site');
	const { tag, date } = options;
	if (!/^v\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/.test(tag)) throw new Error(`Not a release tag: ${tag}`);
	const day = new Date(`${date}T00:00:00Z`);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(day.getTime())) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
	const headline = escapeHtml(options.headline.trim());
	if (!headline) throw new Error('A headline is required');
	const dateLong = day.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

	const indexPath = resolve(site, 'releases/index.html');
	const index = await Bun.file(indexPath).text();
	if (index.includes(`id="${tag}"`)) throw new Error(`${tag} is already in the releases index`);
	const place = index.match(marker);
	const previous = index.match(/<li class="rel-item latest" id="([^"]+)">/)?.[1];
	if (!place || !previous) throw new Error('Releases index has no marker line or no latest release');

	const pagePath = resolve(site, 'releases', tag, 'index.html');
	if (await Bun.file(pagePath).exists()) throw new Error(`${pagePath} already exists`);
	const page = (await Bun.file(options.template ?? resolve(import.meta.dir, 'release-page.template.html')).text())
		.replace(/^<!-- Release page template\..*-->\n/m, '')
		.replaceAll('{{TAG}}', tag).replaceAll('{{DATE_ISO}}', date).replaceAll('{{DATE_LONG}}', dateLong)
		.replaceAll('{{HEADLINE}}', headline).replaceAll('{{PREVIOUS_TAG}}', previous)
		.replaceAll('{{PREVIOUS_SHORT}}', previous.replace(/^v\d+\.\d+\.\d+-/, ''));
	const left = page.match(/\{\{[A-Z_]+\}\}/);
	if (left) throw new Error(`Template field not filled: ${left[0]}`);

	const entry = `    <li class="rel-item latest" id="${tag}">
      <time datetime="${date}">${dateLong}</time>
      <div>
        <h2><a class="ver" href="/releases/${tag}/">${tag}</a> <span class="badge">Latest</span></h2>
        <p class="rel-title">${headline}</p>
        <p>TODO: two sentences on what is in this release.</p>
        <a class="more" href="/releases/${tag}/">Read the release notes&nbsp;→</a>
      </div>
    </li>
`;
	// The release that was latest becomes an ordinary row and keeps its own page.
	const demoted = index.replace('<li class="rel-item latest" id=', '<li class="rel-item" id=').replace(' <span class="badge">Latest</span>', '');
	await mkdir(resolve(site, 'releases', tag), { recursive: true });
	await Bun.write(pagePath, page);
	await Bun.write(indexPath, demoted.replace(marker, (line) => line + entry));
	return pagePath;
}

if (import.meta.main) {
	const [tag, date, ...words] = process.argv.slice(2);
	if (!tag || !date || !words.length) {
		console.error('Usage: bun scripts/new-release-page.ts TAG YYYY-MM-DD "Headline"');
		process.exit(2);
	}
	const path = await addReleasePage({ tag, date, headline: words.join(' ') });
	console.log(`Wrote ${path} and added ${tag} to site/releases/index.html.\nNow write every TODO in both files, then run: bun scripts/check-site.ts && bun test scripts/site.test.ts`);
}
