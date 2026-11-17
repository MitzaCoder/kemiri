/** Real Memory panel, synthetic backend from memory-maintenance-demo.ts; dedicated Chromium and Vite. */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { connectChromiumPage } from '../../../apps/web/scripts/chromium-page.ts';
const fixture = await Bun.file(process.env.MEMORY_DEMO_OUTPUT ?? '/tmp/memory-maintenance-demo.json').json();
const phase = process.env.MEMORY_PROOF_PHASE ?? 'after';
const output = process.env.MEMORY_PROOF_OUTPUT ?? '/tmp/t227-web';
const page = await connectChromiumPage(process.env.MEMORY_CDP ?? 'http://localhost:9497');
await mkdir(output, { recursive: true });
await page.call('Page.enable');
await page.call('Runtime.enable');
await page.call('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('aiki.backends.v1',${JSON.stringify(JSON.stringify([{ id: 'demo', name: 'Memory demo', url: fixture.url }]))});` });
async function waitFor(text: string) {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		if (await page.run(text => document.body?.innerText.includes(text), text)) return;
		await Bun.sleep(150);
	}
	throw new Error('Missing UI: ' + text);
}
async function clickText(group: string, text: string) {
	await page.run((group, text) => {
		const button = [...document.querySelectorAll<HTMLButtonElement>(group + ' button')].find(b => b.textContent?.trim().startsWith(text));
		if (!button) throw new Error('Missing button: ' + text);
		button.click();
	}, group, text);
}
async function screenshot(name: string) {
	await Bun.sleep(350);
	if (await page.run(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Horizontal overflow');
	const shot = await page.call<{ data: string }>('Page.captureScreenshot', { format: 'png' });
	await Bun.write(join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
}
for (const form of ['desktop', 'phone']) for (const theme of ['light', 'dark']) {
	await page.call('Emulation.setDeviceMetricsOverride', { width: form === 'phone' ? 390 : 1440, height: form === 'phone' ? 844 : 1000, deviceScaleFactor: 1, mobile: form === 'phone' });
	await page.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
	await page.call('Page.navigate', { url: fixture.origin + `/b/demo/projects/${fixture.projectId}?tab=memory` });
	await waitFor('Send a message to start');
	await Bun.sleep(1000);
	await page.run(() => document.querySelector<HTMLButtonElement>('[aria-label="More actions"]')?.click());
	await Bun.sleep(300);
	await page.run(() => { const button = document.querySelector<HTMLButtonElement>('[aria-label="Memory"]')!; if (button.getAttribute('aria-pressed') !== 'true') button.click(); });
	await waitFor('Files');
	await clickText('[aria-label="Memory view"]', 'History');
	await clickText('[aria-label="Memory scope"]', 'Project');
	await waitFor('Last run');
	await page.run(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
	if (phase === 'after') await waitFor('The last 3 maintenance runs failed');
	await screenshot(`${phase}-failure-${form}-${theme}`);
	if (phase === 'after') {
		await page.run(() => document.querySelector<HTMLElement>('[data-maintenance-history] summary')!.click());
		await waitFor('Nightly');
		await screenshot(`${phase}-failure-expanded-${form}-${theme}`);
	}
	await clickText('[aria-label="Memory scope"]', 'Global');
	await waitFor('changed memory');
	if (phase === 'after' && await page.run(() => !!document.querySelector('[data-maintenance-warning]'))) throw new Error('Stale scope warning');
	await screenshot(`${phase}-ok-${form}-${theme}`);
}
if (phase === 'after') {
	const frames = join(output, 'frames'); await mkdir(frames, { recursive: true });
	let count = 0;
	const capture = async (samples = 4) => { for (let i = 0; i < samples; i++) { const shot = await page.call<{ data: string }>('Page.captureScreenshot', { format: 'jpeg' }); await Bun.write(join(frames, String(count++).padStart(4, '0') + '.jpg'), Buffer.from(shot.data, 'base64')); await Bun.sleep(200); } };
	// Close then open the actual panel, and unfold both history and the full failure reason.
	console.log('Recording: closing panel');
	await page.run(() => {
		const close = document.querySelector<HTMLButtonElement>('[aria-label="Close the sidebar"], [aria-label="Close panel"], [aria-label="Close panels"]');
		if (close) close.click();
		else {
			const button = document.querySelector<HTMLButtonElement>('[aria-label="Memory"]');
			if (button?.getAttribute('aria-pressed') === 'true') button.click();
		}
	});
	await capture();
	await page.run(() => { if (!document.querySelector('[aria-label="Memory"]')) document.querySelector<HTMLButtonElement>('[aria-label="More actions"]')?.click(); });
	await Bun.sleep(300);
	await page.run(() => document.querySelector<HTMLButtonElement>('[aria-label="Memory"]')!.click());
	await capture();
	await waitFor('Files');
	console.log('Recording: panel open');
	await clickText('[aria-label="Memory view"]', 'History');
	await clickText('[aria-label="Memory scope"]', 'Project');
	await waitFor('The last 3 maintenance runs failed');
	await capture(6);
	console.log('Recording: expanding history');
	await page.run(() => document.querySelector<HTMLElement>('[data-maintenance-history] summary')!.click());
	await capture(6);
	console.log('Recording: expanding reason');
	await page.run(() => document.querySelector<HTMLElement>('[data-maintenance-reason] summary')!.click());
	await capture(6);
	await clickText('[aria-label="Memory scope"]', 'Global');
	await capture(5);
	const encoder = Bun.spawn(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '5', '-i', join(frames, '%04d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(output, 'memory-history-phone-dark.mp4')]);
	if (await encoder.exited !== 0) throw new Error('ffmpeg failed');
	await rm(frames, { recursive: true, force: true });
}
page.close();
console.log('Captured Memory ' + phase + ': ' + output);
