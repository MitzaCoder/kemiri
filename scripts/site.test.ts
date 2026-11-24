import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkSite } from './check-site';
import { addReleasePage } from './new-release-page';
import { DEFAULT_CHECK_INS } from '../packages/protocol/src/projects';
import { TASK_PAUSED_MS } from '../packages/server/src/task-activity';

const bootstrap = resolve(import.meta.dir, '../site/install.sh');
const releasePrefix = 'https://github.com/MitzaCoder/kemiri/releases/download/';

test('site links resolve and the graph images stay identical to the README images', async () => {
	expect(await checkSite()).toBeGreaterThan(20);
	for (const theme of ['light', 'dark']) {
		expect(await Bun.file(resolve(import.meta.dir, `../site/assets/graph-${theme}.webp`)).arrayBuffer())
			.toEqual(await Bun.file(resolve(import.meta.dir, `../docs/assets/readme/graph-${theme}.webp`)).arrayBuffer());
	}
	expect(Bun.spawnSync(['sh', '-n', bootstrap]).exitCode).toBe(0);
});

test('site shares the candlenut master and publishes a complete social card', async () => {
	const root = resolve(import.meta.dir, '..');
	const home = await Bun.file(join(root, 'site/index.html')).text();
	const privacy = await Bun.file(join(root, 'site/privacy/index.html')).text();
	for (const page of [home, privacy]) {
		expect(page).toContain('src="/assets/logo.svg"');
		expect(page).toContain('href="/assets/favicon.svg"');
		expect(page).toContain('rel="apple-touch-icon"');
	}
	expect(await Bun.file(join(root, 'site/assets/logo.svg')).text()).toBe(await Bun.file(join(root, 'assets/brand/logo.svg')).text());
	expect(home).toContain('property="og:image" content="https://kemiri.dev/assets/og.png"');
	expect(home).toContain('name="twitter:card" content="summary_large_image"');
	const image = Buffer.from(await Bun.file(join(root, 'site/assets/og.png')).arrayBuffer());
	expect(image.readUInt32BE(16)).toBe(1200);
	expect(image.readUInt32BE(20)).toBe(630);
});

test('homepage loads only site files, stores nothing and reuses the mascot master', async () => {
	const root = resolve(import.meta.dir, '..');
	const home = await Bun.file(join(root, 'site/index.html')).text();
	const script = await Bun.file(join(root, 'site/home.js')).text();
	const styles = await Bun.file(join(root, 'site/style.css')).text();
	expect(home).toContain('<script src="/home.js" defer></script>');
	expect(styles).toContain('url(/assets/fonts/atkinson-hyperlegible-next-latin.woff2)');
	expect(await Bun.file(join(root, 'site/assets/fonts/OFL.txt')).text()).toContain('SIL Open Font License, Version 1.1');
	// The privacy page promises no tracking; the only script may not store or send anything.
	expect(`${home}${script}`).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
	expect(await Bun.file(join(root, 'site/privacy/index.html')).text()).not.toContain('<script');
	// The demo's animated mascots are drawn from the brand's motion master, not a redrawn copy.
	const master = await Bun.file(join(root, 'assets/brand/mascot-motion.svg')).text();
	const shapes = [...master.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]!);
	expect(shapes.length).toBeGreaterThan(5);
	for (const shape of shapes) expect(home).toContain(` d="${shape}"`);
	// Without scripts the demo window is hidden and the flow, comparison and install steps still read.
	expect(styles).toContain('html:not(.js) .win');
	for (const text of ['Kept by hand', 'With Kemiri', 'Personal, not sandboxed.', 'Keep the backend private.']) expect(home).toContain(text);
});

test('homepage weaves pilot work tracking into the comparison and graph, with qualified defaults', async () => {
	const home = await Bun.file(resolve(import.meta.dir, '../site/index.html')).text();
	const why = home.match(/<section[^>]+aria-labelledby="why-title">([\s\S]*?)<\/section>/)![1]!;
	const real = home.match(/<section[^>]+aria-labelledby="real-title"[^>]*>([\s\S]*?)<\/section>/)![1]!;
	expect(why).toContain('Without a harness, every one of these is a habit you or your agents must remember.');
	expect(why.match(/<s>/g)).toHaveLength(7);
	const timeline = why.match(/<ol class="away-timeline">([\s\S]*?)<\/ol>/)![1]!;
	expect(timeline.match(/<li[ >]/g)).toHaveLength(6);
	// These defaults are public promises. Changes need a homepage review too.
	expect(DEFAULT_CHECK_INS).toEqual({ enabled: true, intervalMinutes: 10 });
	expect(TASK_PAUSED_MS).toBe(15 * 60 * 1000);
	for (const text of ['10 min check-ins', 'By default, while workers run', '15 min quiet', 'Quiet in-progress work', 'one nudge per quiet spell', 'With a maintenance model configured, changed memory']) expect(timeline).toContain(text);
	expect(real.indexOf('class="task-states"')).toBeGreaterThan(real.indexOf('</figure>'));
	const groups = real.match(/<ul class="state-groups"[^>]*>([\s\S]*?)<\/ul>/)![1]!;
	expect([...groups.matchAll(/<b>([^<]+)<\/b>/g)].map(match => match[1])).toEqual(['Needs you', 'In progress', 'Waiting', 'To do', 'Closed']);
	expect(real).toContain('Task updates'); // States include authored updates, not only live facts.
	expect(home).toContain('no Android push in the public APK');
	// Every new diagram icon is local and defined exactly once.
	const references = new Set([...home.matchAll(/<use href="#(h-[^"]+)"/g)].map(match => match[1]));
	for (const id of references) expect(home.match(new RegExp(`<symbol id="${id}"`, 'g'))).toHaveLength(1);
});

test('release notes: every release is in the index, the newest has a finished page, and the homepage links there', async () => {
	const root = resolve(import.meta.dir, '..');
	const index = await Bun.file(join(root, 'site/releases/index.html')).text();
	const listed = [...index.matchAll(/<li class="rel-item(?: latest)?" id="([^"]+)">/g)].map((match) => match[1]!);
	expect(index.match(/class="rel-item latest"/g)).toHaveLength(1);
	expect(index.match(/<span class="badge">Latest<\/span>/g)).toHaveLength(1);
	// Every release with notes in the repository is listed, either with its own page or with its GitHub release.
	const tagged = [...new Bun.Glob('*.md').scanSync(join(root, 'docs/releases'))].map((name) => name.replace(/\.md$/, ''));
	expect(tagged.length).toBeGreaterThan(4);
	for (const tag of tagged) expect(listed).toContain(tag);
	const pinned = (await Bun.file(bootstrap).text()).match(/^version=(v[^\s]+)$/m)?.[1];
	expect(listed).toContain(pinned!);
	const pages = [...new Bun.Glob('*/index.html').scanSync(join(root, 'site/releases'))].map((path) => path.split('/')[0]!);
	expect(pages).toContain(listed[0]!);
	for (const tag of listed) {
		const own = pages.includes(tag);
		expect(index).toContain(own ? `href="/releases/${tag}/"` : `href="https://github.com/MitzaCoder/kemiri/releases/tag/${tag}"`);
		if (!own) continue;
		const page = await Bun.file(join(root, 'site/releases', tag, 'index.html')).text();
		expect(page).toContain(`<link rel="canonical" href="https://kemiri.dev/releases/${tag}/">`);
		expect(page).toContain(`<title>Kemiri ${tag} — release notes</title>`);
		expect(page).toContain(`kemiri update --version ${tag}`);
		expect(page).toContain(`https://github.com/MitzaCoder/kemiri/releases/tag/${tag}`);
		for (const id of ['id="update"', 'id="limits"', 'mailto:support@kemiri.dev', '<script src="/home.js" defer></script>']) expect(page).toContain(id);
		expect(page).not.toMatch(/localStorage|sessionStorage|document\.cookie|fetch\(/);
	}
	for (const tag of pages) expect(listed).toContain(tag);
	// Unwritten template text never reaches the published site.
	for (const path of new Bun.Glob('**/*.html').scanSync(join(root, 'site'))) expect(await Bun.file(join(root, 'site', path)).text()).not.toMatch(/TODO|\{\{/);
	const home = await Bun.file(join(root, 'site/index.html')).text();
	expect(home).toMatch(/<header[\s\S]*?href="\/releases\/"[\s\S]*?<\/header>/);
	expect(home).toMatch(/<footer[\s\S]*?href="\/releases\/"[\s\S]*?<\/footer>/);
	expect(home).toContain(`href="/releases/${pinned}/"`);
});

test('new-release-page starts the next page from the template and makes it the latest in the index', async () => {
	const root = resolve(import.meta.dir, '..');
	const scratch = await mkdtemp(join(tmpdir(), 'kemiri-release-page-'));
	try {
		await mkdir(join(scratch, 'releases'), { recursive: true });
		const before = await Bun.file(join(root, 'site/releases/index.html')).text();
		const latest = before.match(/<li class="rel-item latest" id="([^"]+)">/)![1]!;
		await writeFile(join(scratch, 'releases/index.html'), before);
		const options = { tag: 'v9.8.7-pilot.1', date: '2031-02-03', headline: 'Synthetic <release>', site: scratch };
		await addReleasePage(options);
		const page = await Bun.file(join(scratch, 'releases/v9.8.7-pilot.1/index.html')).text();
		expect(page).toStartWith('<!doctype html>\n<html lang="en">');
		expect(page).not.toMatch(/\{\{|Release page template/);
		expect(page).toContain('<title>Kemiri v9.8.7-pilot.1 — release notes</title>');
		expect(page).toContain('<time datetime="2031-02-03">3 February 2031</time>');
		expect(page).toContain('<h1>Synthetic &lt;release&gt;</h1>');
		expect(page).toContain('kemiri update --version v9.8.7-pilot.1\nkemiri start');
		expect(page).toContain(`Previous: ${latest}`);
		expect(page).toContain('TODO');
		const after = await Bun.file(join(scratch, 'releases/index.html')).text();
		const listed = [...after.matchAll(/<li class="rel-item(?: latest)?" id="([^"]+)">/g)].map((match) => match[1]);
		expect(listed.slice(0, 2)).toEqual(['v9.8.7-pilot.1', latest]);
		expect(after.match(/class="rel-item latest"/g)).toHaveLength(1);
		expect(after.match(/<span class="badge">Latest<\/span>/g)).toHaveLength(1);
		expect(after).toContain(`href="/releases/${latest}/"`);
		await expect(addReleasePage(options)).rejects.toThrow('already in the releases index');
		await expect(addReleasePage({ ...options, tag: 'latest' })).rejects.toThrow('Not a release tag');
		await expect(addReleasePage({ ...options, tag: 'v9.8.7-pilot.2', date: '3 Feb' })).rejects.toThrow('Not a YYYY-MM-DD date');
	} finally { await rm(scratch, { recursive: true, force: true }); }
});

test('homepage install commands match the pinned bootstrap', async () => {
	const home = await Bun.file(resolve(import.meta.dir, '../site/index.html')).text();
	const tag = (await Bun.file(bootstrap).text()).match(/^version=(v[^\s]+)$/m)?.[1];
	if (!tag) throw new Error('Missing pinned default tag in site/install.sh');
	const shown = home.replace(/<[^>]+>/g, '');
	expect(shown).toContain(`curl -fL https://kemiri.dev/install.sh -o install.sh\n# Read install.sh before running it.\nsh install.sh --version ${tag} --no-service\nkemiri start`);
	expect(shown).toContain('kemiri open\nkemiri pair');
	// The copy button leaves the comment out and must carry the same commands.
	expect(home).toContain(`data-copy="curl -fL https://kemiri.dev/install.sh -o install.sh&#10;sh install.sh --version ${tag} --no-service&#10;kemiri start"`);
	expect(home).toContain(`${releasePrefix}${tag}/kemiri-${tag}-android-universal.apk`);
	for (const [version] of home.matchAll(/\bv\d+\.\d+\.\d+-[\w.]+\b/g)) expect(version).toBe(tag);
});

test('site checker rejects resources loaded from other origins and missing stylesheet files', async () => {
	const scratch = await mkdtemp(join(tmpdir(), 'kemiri-site-resources-'));
	const page = (extra: string) => `<!doctype html><html lang="en"><title>Kemiri</title><a href="https://kemiri.dev/">Kemiri</a>${extra}</html>`;
	try {
		await writeFile(join(scratch, 'CNAME'), 'kemiri.dev\n');
		await writeFile(join(scratch, 'index.html'), page('<script src="https://cdn.example.org/widget.js"></script>'));
		await expect(checkSite(scratch)).rejects.toThrow('External resource');
		await writeFile(join(scratch, 'index.html'), page('<link rel="stylesheet" href="https://fonts.example.org/css">'));
		await expect(checkSite(scratch)).rejects.toThrow('External resource');
		await writeFile(join(scratch, 'index.html'), page(''));
		await writeFile(join(scratch, 'other.html'), page(''));
		await writeFile(join(scratch, 'style.css'), '@font-face { src: url(/assets/missing.woff2); }');
		await expect(checkSite(scratch)).rejects.toThrow('Missing target');
		await writeFile(join(scratch, 'style.css'), '@font-face { src: url(https://fonts.example.org/a.woff2); }');
		await expect(checkSite(scratch)).rejects.toThrow('not a site path');
	} finally { await rm(scratch, { recursive: true, force: true }); }
});

test('site uses canonical Kemiri links and preserves privacy promises', async () => {
	const root = resolve(import.meta.dir, '../site');
	const home = await Bun.file(join(root, 'index.html')).text();
	const privacy = await Bun.file(join(root, 'privacy/index.html')).text();
	expect(home).toContain('curl -fsSL https://kemiri.dev/install.sh | sh');
	for (const [page, path] of [[home, '/'], [privacy, '/privacy/']]) {
		expect(page).toContain(`<link rel="canonical" href="https://kemiri.dev${path}">`);
		expect(page).toContain('mailto:support@kemiri.dev');
		expect(page).not.toContain('https://github.com/MitzaCoder/aiki');
	}
	expect(privacy).toContain('no analytics, tracking cookies, forms or external fonts');
	expect(privacy).toContain('There is no Kemiri-hosted account or central service receiving your conversations in this pilot.');
	expect(privacy).toContain('A future push relay is not active in this pilot.');
});

test('current install guides use the live domain; app help has no retired-domain links', async () => {
	for (const path of ['README.md', 'docs/INSTALL.md', 'docs/AGENT-INSTALL.md', 'docs/SITE.md']) {
		const text = await Bun.file(resolve(import.meta.dir, '../', path)).text();
		expect(text).toContain('https://kemiri.dev/install.sh');
		expect(text).not.toContain('https://aikilabs.dev');
	}
	for (const directory of ['apps/web/src', 'apps/android/app/src/main']) {
		for (const path of new Bun.Glob('**/*.{svelte,ts,kt,xml}').scanSync(resolve(import.meta.dir, '../', directory))) {
			const text = await Bun.file(resolve(import.meta.dir, '../', directory, path)).text();
			expect(text).not.toContain('aikilabs.dev');
		}
	}
});

test('agent install pin matches the site installer default and all fresh install commands use it', async () => {
	const installer = await Bun.file(bootstrap).text();
	const guide = await Bun.file(resolve(import.meta.dir, '../docs/AGENT-INSTALL.md')).text();
	const defaultTag = installer.match(/^version=(v[^\s]+)$/m)?.[1];
	if (!defaultTag) throw new Error('Missing pinned default tag in site/install.sh');
	const guidePins = [...guide.matchAll(/^\s*KEMIRI_VERSION=(v[^\s]+)$/gm)];
	expect(guidePins).toHaveLength(1);
	expect(guidePins[0]?.[1]).toBe(defaultTag);
	expect(guide).toContain('releases/download/$KEMIRI_VERSION');
	expect(guide).toContain('sh install.sh --version "$KEMIRI_VERSION" --dir "$KEMIRI_ROOT" --no-service');
	expect(guide).toContain('sh install.sh --version "$KEMIRI_VERSION" --runtime bun --dir "$KEMIRI_ROOT" --no-service');
	expect(guide).toContain('"refs/tags/$KEMIRI_VERSION^{}"');
	// The bridge is intentionally historical, never a fresh installation pin.
	expect(guide).not.toMatch(/sh (?:install|install-bootstrap)\.sh --version v/);
	expect(guide).not.toContain('aiki-$KEMIRI_VERSION');
	expect(guide).toContain('kemiri-$KEMIRI_VERSION-android-universal.apk');
});

test('site checker rejects the retired bootstrap host with no exception', async () => {
	const scratch = await mkdtemp(join(tmpdir(), 'kemiri-retired-site-'));
	try {
		await writeFile(join(scratch, 'index.html'), '<!doctype html><html lang="en"><title>Kemiri</title><a href="https://kemiri.dev/">Kemiri</a><code>curl https://aikilabs.dev/install.sh</code></html>');
		await expect(checkSite(scratch)).rejects.toThrow('Stale public identity');
	} finally { await rm(scratch, { recursive: true, force: true }); }
});

type Sidecar = 'valid' | 'mismatch' | 'missing' | 'malformed' | 'other-file' | 'multiple';
async function rehearseBootstrap(args: string[], sidecar: Sidecar = 'valid', installerExit = 0) {
	const scratch = await mkdtemp(join(tmpdir(), 'aiki-site-test-'));
	const requests: string[] = [];
	const installer = '#!/bin/sh\nprintf "%s\\n" "$@" > "$KEMIRI_TEST_ARGS"\nexit "$KEMIRI_TEST_EXIT"\n';
	const digest = new Bun.CryptoHasher('sha256').update(installer).digest('hex');
	const server = Bun.serve({
		hostname: '127.0.0.1', port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			requests.push(path);
			if (path.endsWith('/install.sh')) return new Response(installer);
			if (!path.endsWith('/install.sh.sha256') || sidecar === 'missing') return new Response('Not found', { status: 404 });
			const checksum = sidecar === 'mismatch' ? '0'.repeat(64) : digest;
			const contents = sidecar === 'malformed' ? 'not a checksum' : `${checksum}  ${sidecar === 'other-file' ? '/etc/passwd' : 'install.sh'}\n`;
			return new Response(sidecar === 'multiple' ? contents + contents : contents);
		},
	});
	try {
		await mkdir(join(scratch, 'bin'));
		await mkdir(join(scratch, 'tmp'));
		// Only the test process changes curl's destination. Production has no
		// environment variable or flag that can replace its HTTPS installer host.
		await writeFile(join(scratch, 'bin/curl'), `#!/bin/sh
for argument do
 case "$argument" in ${releasePrefix}*) url=$argument ;; esac
done
while [ "$#" -gt 0 ]; do
 case $1 in -o) output=$2; shift 2 ;; *) shift ;; esac
done
exec "$KEMIRI_TEST_CURL" -fsSL "$KEMIRI_TEST_ORIGIN/\${url#${releasePrefix}}" -o "$output"
`, { mode: 0o700 });
		const child = Bun.spawn(['sh', bootstrap, ...args], {
			env: { ...process.env, PATH: `${scratch}/bin:${process.env.PATH}`, TMPDIR: join(scratch, 'tmp'),
				KEMIRI_TEST_CURL: Bun.which('curl')!, KEMIRI_TEST_ORIGIN: server.url.origin,
				KEMIRI_TEST_ARGS: join(scratch, 'args'), KEMIRI_TEST_EXIT: String(installerExit) },
			stdout: 'pipe', stderr: 'pipe',
		});
		const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		const executed = await Bun.file(join(scratch, 'args')).exists();
		const forwarded = executed ? (await Bun.file(join(scratch, 'args')).text()).trimEnd().split('\n') : [];
		const leftovers = [...new Bun.Glob('*').scanSync(join(scratch, 'tmp'))];
		return { stdout, stderr, exitCode, executed, forwarded, requests, leftovers };
	} finally {
		server.stop(true);
		await rm(scratch, { recursive: true, force: true });
	}
}

test('bootstrap dry run verifies a pinned default and forwards arguments without word splitting', async () => {
	const run = await rehearseBootstrap(['--no-service', '--dir', '/tmp/example install']);
	expect(run.exitCode).toBe(0);
	expect(run.stdout).toContain('verified GitHub release installer v0.1.0-pilot.7');
	expect(run.forwarded).toEqual(['--version', 'v0.1.0-pilot.7', '--no-service', '--dir', '/tmp/example install']);
	expect(run.requests).toEqual(['/v0.1.0-pilot.7/install.sh', '/v0.1.0-pilot.7/install.sh.sha256']);
	expect(run.leftovers).toEqual([]);
});

test('explicit --version selects both installer assets, preserves args and propagates failure', async () => {
	const args = ['--version', 'v0.0.0-test.150', '--runtime', 'bun', '--no-service'];
	const run = await rehearseBootstrap(args, 'valid', 17);
	expect(run.exitCode).toBe(17);
	expect(run.forwarded).toEqual(args);
	expect(run.requests).toEqual(['/v0.0.0-test.150/install.sh', '/v0.0.0-test.150/install.sh.sha256']);
	expect(run.leftovers).toEqual([]);
});

for (const sidecar of ['mismatch', 'missing', 'malformed', 'other-file', 'multiple'] as const) {
	test(`bootstrap never executes on ${sidecar} checksum and cleans downloads`, async () => {
		const run = await rehearseBootstrap([], sidecar);
		expect(run.exitCode).not.toBe(0);
		expect(run.executed).toBe(false);
		expect(run.leftovers).toEqual([]);
	});
}

for (const args of [['--version'], ['--version', 'latest'], ['--version', '../escape'], ['--version', 'https://example.org/installer']]) {
	test(`bootstrap rejects non-exact version ${JSON.stringify(args)} before downloading`, async () => {
		const run = await rehearseBootstrap(args);
		expect(run.exitCode).not.toBe(0);
		expect(run.requests).toEqual([]);
		expect(run.executed).toBe(false);
	});
}

type PagesJob = { permissions: Record<string, string>; if?: string; needs?: string; environment?: { name: string }; steps: { uses?: string; with?: Record<string, unknown> }[] };
type PagesWorkflow = { on: { push: { branches: string[]; paths: string[] }; workflow_dispatch: unknown }; permissions: Record<string, string>; jobs: { build: PagesJob; deploy: PagesJob } };

test('Pages only publishes main, with immutable actions and separated permissions', async () => {
	const workflow = Bun.YAML.parse(await Bun.file(resolve(import.meta.dir, '../.github/workflows/pages.yml')).text()) as PagesWorkflow;
	expect(workflow.on.push.branches).toEqual(['main']);
	expect(workflow.on.push.paths).toContain('site/**');
	expect(Object.hasOwn(workflow.on, 'workflow_dispatch')).toBe(true);
	expect(workflow.permissions).toEqual({});
	expect(workflow.jobs.build.permissions).toEqual({ contents: 'read' });
	expect(workflow.jobs.deploy.permissions).toEqual({ pages: 'write', 'id-token': 'write' });
	expect(workflow.jobs.deploy.if).toBe("github.ref == 'refs/heads/main'");
	expect(workflow.jobs.deploy.needs).toBe('build');
	expect(workflow.jobs.deploy.environment?.name).toBe('github-pages');
	for (const job of Object.values(workflow.jobs)) {
		for (const step of job.steps) if (step.uses) {
			expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
			if (step.uses.startsWith('actions/checkout@')) expect(step.with?.['persist-credentials']).toBe(false);
		}
	}
});
