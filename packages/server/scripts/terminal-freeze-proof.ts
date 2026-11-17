/** Real web terminal, synthetic Zellij fixture, dedicated headless Chromium. Simulates a half-open socket. */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { connectChromiumPage } from '../../../apps/web/scripts/chromium-page.ts';
const phase = process.argv[2] ?? 'before';
const output = `/tmp/terminal-freeze-${phase}`;
await mkdir(output, { recursive: true });
const fixture = await Bun.file('/tmp/terminal-freeze-demo.json').json();
const page = await connectChromiumPage('http://localhost:9495');
await page.call('Page.enable');
await page.call('Runtime.enable');
await page.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await page.call('Page.addScriptToEvaluateOnNewDocument', { source: `
localStorage.clear();
localStorage.setItem('aiki.backends.v1', ${JSON.stringify(JSON.stringify([{ id: 'demo', name: 'Terminal demo', url: fixture.url }]))});
// Shorten only the watchdog's timers, identically in both runs. No application state is modified.
const schedule = window.setTimeout.bind(window);
window.setTimeout = (fn, ms, ...args) => schedule(fn, ms === 30000 ? 1500 : ms === 10000 ? 1000 : ms, ...args);
const NativeSocket = window.WebSocket;
window.demoSockets = [];
window.WebSocket = class extends NativeSocket {
  constructor(url, protocols) { super(url, protocols); this.silent = false; if (String(url).endsWith('/ws')) window.demoSockets.push(this); }
  send(data) { if (!this.silent) super.send(data); }
  set onclose(callback) { super.onclose = event => { if (!this.silent) callback?.(event); }; }
  dropSilently() { this.silent = true; super.close(); }
};
` });
await page.call('Page.navigate', { url: `http://localhost:5295/b/demo/terminal?session=freeze-demo-${phase}-${Date.now()}` });
async function waitFor(check: () => Promise<boolean>, what: string) {
  const until = Date.now() + 25000;
  while (Date.now() < until) { if (await check()) return; await Bun.sleep(150); }
  throw new Error('Missing ' + what);
}
await waitFor(() => page.run(() => !!document.querySelector('.xterm-helper-textarea')), 'terminal');
await Bun.sleep(2000);
async function type(text: string) {
  await page.run(() => document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!.focus());
  await page.call('Input.insertText', { text });
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
await type("PS1='demo $ '; printf '\\033]0;Demo shell\\007'; clear; export DEMO_VALUE=42; printf 'Ready before link loss\\n'");
await Bun.sleep(1000);
const frames = join(output, 'frames'); await mkdir(frames, { recursive: true });
let count = 0;
async function capture() {
  const shot = await page.call<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
  await Bun.write(join(frames, String(count++).padStart(5, '0') + '.jpg'), Buffer.from(shot.data, 'base64'));
}
await capture();
await page.run(() => { (window as any).demoSockets.at(-1).dropSilently(); });
await type("printf 'Recovered value: %s\\n' \"$DEMO_VALUE\"");
for (let i = 0; i < 76; i++) { await Bun.sleep(250); await capture(); }
await type("printf 'Recovered value: %s\\n' \"$DEMO_VALUE\"");
for (let i = 0; i < 8; i++) { await Bun.sleep(250); await capture(); }
const sockets = await page.run(() => (window as any).demoSockets.length);
if (phase === 'before' && sockets !== 1) throw new Error('Before unexpectedly reconnected');
if (phase === 'after' && sockets < 2) throw new Error('After failed to reconnect');
const shot = await page.call<{ data: string }>('Page.captureScreenshot', { format: 'png' });
await Bun.write(join(output, `terminal-${phase}.png`), Buffer.from(shot.data, 'base64'));
const encoder = Bun.spawn(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '4', '-i', join(frames, '%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(output, `terminal-${phase}.mp4`)], { stdout: 'ignore', stderr: 'pipe' });
if (await encoder.exited !== 0) throw new Error(await new Response(encoder.stderr).text());
await rm(frames, { recursive: true, force: true });
console.log(JSON.stringify({ phase, sockets, output }));
page.close();
