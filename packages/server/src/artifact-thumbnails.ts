import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { findBrowserExecutable } from "./agent-browser.ts";
import { childEnvironment } from "./child-environment.ts";

const MAX_HTML_BYTES = 1024 * 1024;
const MAX_PENDING = 12;
const RENDER_TIMEOUT_MS = 5000;
const THUMBNAIL_FILE = ".kemiri-preview-v1.webp";

/** Deduplicated, single-lane backfill of requested versions. The WebP lives next to the bytes it was made from. */
export class ArtifactThumbnails {
	readonly #render: typeof renderArtifactThumbnail;
	readonly #pending = new Map<string, Promise<string | undefined>>();
	#tail: Promise<unknown> = Promise.resolve();

	constructor(render = renderArtifactThumbnail) { this.#render = render; }

	async find(source: string, allowRender: boolean): Promise<string | undefined> {
		const preview = join(dirname(source), THUMBNAIL_FILE);
		if (await Bun.file(preview).exists()) return preview;
		if (!allowRender) return undefined;
		const running = this.#pending.get(source);
		if (running) return running;
		if (this.#pending.size >= MAX_PENDING) return undefined;
		const job = this.#tail.then(async () => {
			const partial = `${preview}.${randomUUID()}.part`;
			try {
				if (await Bun.file(preview).exists()) return preview;
				const file = Bun.file(source);
				if (!(await file.exists()) || file.size > MAX_HTML_BYTES) return undefined;
				// Read only a bounded immutable version, never use its location as a browser origin.
				const html = await file.slice(0, MAX_HTML_BYTES).text();
				const bytes = await this.#render(html);
				if (!bytes?.length) return undefined;
				await Bun.write(partial, bytes, { createPath: false, mode: 0o600 });
				await rename(partial, preview);
				return preview;
			} catch {
				return undefined; // Missing sandbox, timed out, or the artifact was pruned/deleted.
			} finally {
				await rm(partial, { force: true }).catch(() => {});
			}
		}).finally(() => this.#pending.delete(source));
		this.#pending.set(source, job);
		this.#tail = job;
		return job;
	}
}

/** CDP over inherited pipes: there is no network-facing debugger or page server. */
export async function renderArtifactThumbnail(html: string): Promise<Uint8Array | undefined> {
	const chromium = findBrowserExecutable();
	if (!chromium) return undefined;
	const profile = await mkdtemp(join(tmpdir(), "kemiri-thumbnail-"));
	// Keep only launch/locale settings from the audited child environment.
	const { PATH, LANG } = childEnvironment();
	const browser = spawn(chromium, [
		"--headless", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
		"--disable-background-networking", "--disable-component-update", "--disable-extensions", "--disable-sync",
		"--host-resolver-rules=MAP * ~NOTFOUND", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "about:blank",
	], {
		cwd: profile, detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
		env: { PATH, LANG, HOME: profile, XDG_CONFIG_HOME: profile, XDG_CACHE_HOME: profile },
	});
	const input = browser.stdio[3] as Writable;
	const output = browser.stdio[4] as Readable;
	let id = 0;
	let buffer = "";
	let pending: { resolve(value: any): void; reject(reason: Error): void } | undefined;
	let failure: Error | undefined;
	let loadingFrame: { ready(): void; reject(error: Error): void } | undefined;
	const fail = (error: Error) => { failure = error; pending?.reject(error); pending = undefined; loadingFrame?.reject(error); };
	const closed = new Promise<void>(resolve => { browser.on("close", () => { fail(new Error("Renderer closed")); resolve(); }); });
	browser.on("error", fail);
	input.on("error", fail);
	output.on("error", fail);
	output.setEncoding("utf8").on("data", (chunk: string) => {
		buffer += chunk;
		for (let end = buffer.indexOf("\0"); end >= 0; end = buffer.indexOf("\0")) {
			const message = JSON.parse(buffer.slice(0, end));
			buffer = buffer.slice(end + 1);
			if (loadingFrame && message.method === "Page.loadEventFired") loadingFrame.ready();
			if (message.id !== id || !pending) continue;
			const request = pending;
			pending = undefined;
			if (message.error) request.reject(new Error("Chromium refused a snapshot command"));
			else request.resolve(message.result);
		}
	});
	const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
		if (failure) { reject(failure); return; }
		pending = { resolve, reject };
		input.write(`${JSON.stringify({ id: ++id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
	});
	const timer = setTimeout(() => fail(new Error("Renderer deadline")), RENDER_TIMEOUT_MS);
	try {
		const { targetId } = await send("Target.createTarget", { url: "about:blank" });
		const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
		await send("Page.enable", {}, sessionId);
		await send("Network.enable", {}, sessionId);
		await send("Network.setBlockedURLs", { urls: ["*://*"] }, sessionId);
		await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);
		await send("Emulation.setScriptExecutionDisabled", { value: true }, sessionId);
		await send("Emulation.setDeviceMetricsOverride", { width: 800, height: 450, mobile: false, deviceScaleFactor: 0.5 }, sessionId);
		const { frameTree } = await send("Page.getFrameTree", {}, sessionId);
		const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
		const ready = new Promise<void>((resolve, reject) => { loadingFrame = { ready: resolve, reject }; });
		await Promise.all([send("Page.setDocumentContent", { frameId: frameTree.frame.id,
			html: thumbnailDocument(html, csp),
		}, sessionId), ready]);
		loadingFrame = undefined;
		const { data } = await send("Page.captureScreenshot", { format: "webp", quality: 78, fromSurface: true }, sessionId);
		return Buffer.from(data, "base64");
	} finally {
		clearTimeout(timer);
		if (browser.pid) {
			try { if (process.platform === "win32") browser.kill(); else process.kill(-browser.pid, "SIGKILL"); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
		}
		await closed;
		await rm(profile, { recursive: true, force: true });
	}
}

function thumbnailDocument(html: string, csp: string): string {
	const page = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${html}`;
	const escaped = page.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	return `<!doctype html><style>body{margin:0}iframe{border:0;width:100vw;height:100vh;display:block}</style><iframe sandbox srcdoc="${escaped}"></iframe>`;
}
