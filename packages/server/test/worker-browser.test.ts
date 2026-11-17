import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { GenerationHooks, HookApi, RunSummary } from "@earendil-works/pi-durable";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnvironment } from "../src/child-environment.ts";
import { WorkerBrowserService, workerBrowserInstructions, type WorkerBrowser } from "../src/worker-browser.ts";
import { createWorkerBrowserExtension, workerInstructions, type WorkerRecord } from "../src/workers.ts";
import { resolveArtifactSource } from "../src/artifact-tools.ts";

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "ab-worker-test-"));
	const binary = join(root, "fake-browser");
	await writeFile(binary, `#!/bin/sh
case "$1" in
open)
  "$0" daemon >/dev/null 2>&1 < /dev/null &
  echo $! > "$AGENT_BROWSER_SOCKET_DIR/$AGENT_BROWSER_SESSION.pid"
  ;;
daemon)
  sleep 300 &
  echo $! > "$AGENT_BROWSER_SOCKET_DIR/child.pid"
  wait
  ;;
orphan) sleep 300 & echo $! > "$2"; wait ;;\nclose) exit 1 ;;
env) env ;;
esac
`, { mode: 0o755 });
	const logs: string[] = [];
	const options = { dataDir: root, log: (message: string) => { logs.push(message); }, installer: { ensure: async () => binary }, findBrowser: () => "/opt/fixture/chromium", command: () => undefined, offer: () => {} };
	return { root, binary, options, logs, service: new WorkerBrowserService(options) };
}
async function run(browser: WorkerBrowser, command: string): Promise<string> {
	const process = Bun.spawn([browser.launcher, command], { env: childEnvironment(), stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => process.kill("SIGKILL"), 2000);
	try {
		const output = await new Response(process.stdout).text();
		expect(await process.exited).toBe(0);
		return output;
	} finally { clearTimeout(timer); }
}
async function running(pid: number): Promise<boolean> {
	try {
		if (process.platform === "linux") return !(await readFile(`/proc/${pid}/stat`, "utf8")).includes(") Z ");
		process.kill(pid, 0); return true;
	} catch { return false; }
}
async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
	const until = Date.now() + 2500;
	while (!await predicate()) {
		if (Date.now() >= until) throw new Error("Timed out waiting for fake process");
		await Bun.sleep(10);
	}
}

test("no Chromium means no download and a plain stable worker message", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "ab-no-browser-"));
	let installs = 0;
	try {
		const service = new WorkerBrowserService({ dataDir: fixture, findBrowser: () => null, installer: { ensure: async () => { installs++; throw new Error("must not install"); } }, log: () => {} });
		const reason = await service.prepare("project", 1, await service.ensureReady());
		expect(reason).toBe("no Chromium or Chrome found; install one or set KEMIRI_BROWSER_EXECUTABLE.");
		expect(workerBrowserInstructions(reason)).toBe(`Browser unavailable: ${reason}`);
		expect(installs).toBe(0);
	} finally { await rm(fixture, { recursive: true, force: true }); }
});

test("failed install is logged, worker informed and a later spawn retries", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "ab-offline-worker-"));
	let installs = 0;
	const logs: string[] = [];
	try {
		const service = new WorkerBrowserService({ dataDir: fixture, findBrowser: () => "/opt/chromium", installer: { ensure: async () => { installs++; throw new Error("offline"); } }, log: message => { logs.push(message); } });
		expect(await service.prepare("project", 1, await service.ensureReady())).toContain("offline");
		expect(await service.prepare("project", 2, await service.ensureReady())).toContain("offline");
		expect(installs).toBe(2);
		expect(logs).toEqual(["agent-browser setup failed: offline", "agent-browser setup failed: offline"]);
	} finally { await rm(fixture, { recursive: true, force: true }); }
});

test("private launcher carries environment across shell calls; proof is an allowed artifact source", async () => {
	const fixture = await createFixture();
	const browsers: WorkerBrowser[] = [];
	try {
		for (const [project, id] of [["project", 1], ["project", 2], ["other", 1]] as const) {
			const browser = await fixture.service.prepare(project, id, await fixture.service.ensureReady());
			if (typeof browser === "string") throw new Error(browser);
			browsers.push(browser);
		}
		expect(new Set(browsers.map(browser => browser.directory)).size).toBe(3);
		const browser = browsers[0]!;
		expect(await fixture.service.prepare("project", 1, await fixture.service.ensureReady())).toEqual(browser);
		expect(Buffer.byteLength(join(browser.socket, `${browser.session}.sock`))).toBeLessThan(104);
		const environment = await run(browser, "env");
		for (const value of [`HOME=${browser.directory}/home`, `TMPDIR=${browser.directory}/tmp`, `AGENT_BROWSER_SESSION=${browser.session}`,
			`AGENT_BROWSER_SOCKET_DIR=${browser.socket}`, "AGENT_BROWSER_EXECUTABLE_PATH=/opt/fixture/chromium", "AGENT_BROWSER_NO_VERSION_CHECK=1",
			"AGENT_BROWSER_ALLOWED_DOMAINS=localhost,127.0.0.1,[::1],::1", `BROWSER_PROOF_DIR=${browser.proof}`]) expect(environment).toContain(value);
		const instructions = workerBrowserInstructions(browser);
		expect(instructions).toContain(`use ${browser.launcher} as ab`);
		expect(instructions).toContain("proof stays until forget");
		expect(workerInstructions({ id: "proof", title: "Check browser", cwd: fixture.root, isolation: "shared", project: { id: "project", name: "Fixture", path: fixture.root } as Parameters<typeof workerInstructions>[0]["project"], browserInstructions: instructions })).toContain(instructions);
		const proof = join(browser.proof, "proof.txt");
		await writeFile(proof, "synthetic proof");
		expect(await resolveArtifactSource({ path: proof, cwd: fixture.root, projectPath: fixture.root, dataDir: fixture.root, workspaceDirs: [] })).toEqual({ ok: true, path: proof });
		await fixture.service.cleanup("project", 1);
		expect(await Bun.file(proof).exists()).toBe(true);
		await fixture.service.cleanup("project", 1, true);
		expect(await Bun.file(browser.launcher).exists()).toBe(false);
	} finally {
		await fixture.service.cleanup("project", 1, true);
		await fixture.service.cleanup("project", 2, true);
		await fixture.service.cleanup("other", 1, true);
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("explicit command bypasses install and allowed domains are carried unchanged", async () => {
	const fixture = await createFixture();
	const service = new WorkerBrowserService({ ...fixture.options, command: () => fixture.binary, allowedDomains: "localhost,example.com", installer: { ensure: async () => { throw new Error("must not install"); } } });
	try {
		const browser = await service.prepare("project", 1, await service.ensureReady());
		if (typeof browser === "string") throw new Error(browser);
		expect(await run(browser, "env")).toContain("AGENT_BROWSER_ALLOWED_DOMAINS=localhost,example.com");
	} finally { await service.cleanup("project", 1, true); await rm(fixture.root, { recursive: true, force: true }); }
});

test("cleanup kills only owned fake daemon/tree; startup sweep catches crash leftovers; forget removes directories", async () => {
	const fixture = await createFixture();
	const unrelated = Bun.spawn(["sleep", "300"], { env: childEnvironment(), stdout: "ignore", stderr: "ignore" });
	try {
		const browser = await fixture.service.prepare("project", 1, await fixture.service.ensureReady());
		if (typeof browser === "string") throw new Error(browser);
		const proof = join(browser.proof, "keep.txt");
		await writeFile(proof, "proof survives cleanup and restart");
		for (const startup of [false, true]) {
			await run(browser, "open");
			await waitFor(() => Bun.file(join(browser.socket, "child.pid")).exists());
			const daemon = Number(await readFile(join(browser.socket, `${browser.session}.pid`), "utf8"));
			const child = Number(await readFile(join(browser.socket, "child.pid"), "utf8"));
			expect(await running(daemon)).toBe(true);
			expect(await running(child)).toBe(true);
			if (startup) await new WorkerBrowserService(fixture.options).ready;
			else await fixture.service.cleanup("project", 1);
			await waitFor(async () => !await running(daemon) && !await running(child));
			expect(await running(unrelated.pid)).toBe(true);
			expect(await Bun.file(proof).exists()).toBe(true);
			await rm(join(browser.socket, "child.pid"), { force: true });
		}
		// A forged/stale pid file cannot authorize killing somebody else's process.
		await writeFile(join(browser.socket, `${browser.session}.pid`), String(unrelated.pid));
		await fixture.service.cleanup("project", 1, true);
		expect(await running(unrelated.pid)).toBe(true);
		expect(await Bun.file(browser.launcher).exists()).toBe(false);
		expect(await readdir(join(fixture.root, "tools/browser-workers"))).toEqual([]);
	} finally {
		await fixture.service.cleanup("project", 1, true);
		unrelated.kill("SIGKILL"); await unrelated.exited;
		await rm(fixture.root, { recursive: true, force: true });
	}
}, 10_000);


test("run-end hook starts cleanup without waiting for it; next request waits, coordinators are untouched", async () => {
	let worker = true;
	const events: string[] = [];
	let finish!: () => void;
	const pending = new Promise<void>(resolve => { finish = resolve; });
	const record: WorkerRecord = {
		id: "worker", title: "test", conversationId: 2, isolation: "shared", workspacePath: null,
		model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: null, status: "running",
		spawnedByCallId: null, taskId: null, createdAt: "", updatedAt: "", lastReport: null, failure: null, anchorTaskId: 1,
	};
	const extension = createWorkerBrowserExtension({
		workerOf: async () => worker ? { record, threadId: "main" } : undefined,
		cleanupBrowser: () => { events.push("cleanup"); return pending; },
		waitBrowser: async () => { events.push("wait"); await pending; events.push("ready"); },
	});
	const hooks = extension.hooks![0]!.handlers as GenerationHooks;
	const api = { conversationId: 2 } as HookApi;
	await hooks.afterRun({ first: 1, last: 2, answer: 2, reason: "answer" } as RunSummary, api, BACKGROUND_CONTEXT);
	expect(events).toEqual(["cleanup"]); // Does not await the unresolved cleanup promise.
	const request = { messages: [] };
	const next = hooks.beforeRequest(request, api, BACKGROUND_CONTEXT);
	await Promise.resolve(); await Promise.resolve();
	expect(events).toEqual(["cleanup", "wait"]);
	finish(); await next;
	expect(events).toEqual(["cleanup", "wait", "ready"]);
	worker = false;
	await hooks.afterRun({} as RunSummary, api, BACKGROUND_CONTEXT);
	await hooks.beforeRequest(request, api, BACKGROUND_CONTEXT);
	expect(events).toEqual(["cleanup", "wait", "ready"]);
});

test("a reparented browser profile owns its descendants even without inherited session environment", async () => {
	const fixture = await createFixture();
	let orphan: ReturnType<typeof Bun.spawn> | undefined;
	try {
		const browser = await fixture.service.prepare("project", 1, await fixture.service.ensureReady());
		if (typeof browser === "string") throw new Error(browser);
		const childPid = join(browser.socket, "orphan-child.pid");
		orphan = Bun.spawn([fixture.binary, "orphan", childPid, `--user-data-dir=${browser.directory}/tmp/agent-browser-chrome-fixture`], {
			env: childEnvironment(), stdout: "ignore", stderr: "ignore",
		});
		await waitFor(() => Bun.file(childPid).exists());
		const child = Number(await readFile(childPid, "utf8"));
		expect(await running(orphan.pid)).toBe(true);
		await fixture.service.cleanup("project", 1);
		await waitFor(async () => !await running(orphan!.pid) && !await running(child));
	} finally {
		await fixture.service.cleanup("project", 1, true);
		if (orphan) { orphan.kill("SIGKILL"); await orphan.exited; }
		await rm(fixture.root, { recursive: true, force: true });
	}
});


test("a resumed worker repairs its stable launcher for the current pin once per process and fails closed offline", async () => {
	const fixture = await createFixture();
	try {
		const browser = await fixture.service.prepare("project", 1, await fixture.service.ensureReady());
		if (typeof browser === "string") throw new Error(browser);
		const nextBinary = join(fixture.root, "new-pin");
		await writeFile(nextBinary, "#!/bin/sh\necho current-pin\n", { mode: 0o755 });
		let installs = 0;
		const restarted = new WorkerBrowserService({ ...fixture.options, installer: { ensure: async () => { installs++; return nextBinary; } } });
		await restarted.ready;
		await restarted.wait("project", 1);
		await restarted.wait("project", 1);
		expect(installs).toBe(1);
		expect(await run(browser, "env")).toContain("current-pin");
		expect(await readFile(browser.launcher, "utf8")).toContain(nextBinary);
		expect(await readFile(browser.launcher, "utf8")).toContain(browser.session);
		const offline = new WorkerBrowserService({ ...fixture.options, installer: { ensure: async () => { throw new Error("offline"); } } });
		await offline.wait("project", 1);
		const command = Bun.spawn([browser.launcher, "open"], { env: childEnvironment(), stdout: "ignore", stderr: "pipe" });
		expect(await command.exited).toBe(1);
		expect(await new Response(command.stderr).text()).toContain("Browser unavailable: agent-browser setup failed: offline");
	} finally { await fixture.service.cleanup("project", 1, true); await rm(fixture.root, { recursive: true, force: true }); }
});


test("ensureReady shares installation and caches verification; prepare only consumes its settled result", async () => {
	const fixture = await createFixture();
	let installs = 0;
	let discoveries = 0;
	let insideCommit = false;
	let finish!: () => void;
	const gate = new Promise<void>(resolve => { finish = resolve; });
	const service = new WorkerBrowserService({ ...fixture.options,
		findBrowser: () => { if (insideCommit) throw new Error("browser discovery inside commit"); discoveries++; return "/opt/fixture/chromium"; },
		installer: { ensure: async () => {
			if (insideCommit) throw new Error("download/hash verification inside commit");
			installs++; await gate; return fixture.binary;
		} },
	});
	try {
		const first = service.ensureReady();
		const concurrent = service.ensureReady();
		expect(concurrent).toBe(first);
		finish();
		const availability = await first;
		expect(typeof availability).toBe("object");
		expect(installs).toBe(1);
		// Remove the binary itself: prepare must not read it or try to verify/repair it.
		await rm(fixture.binary);
		insideCommit = true;
		const browser = await service.prepare("project", 21, availability, "stable-spawn-call");
		const repeated = await service.prepare("project", 21, availability, "stable-spawn-call");
		const retried = await service.prepare("project", 22, availability, "stable-spawn-call");
		expect(typeof browser).toBe("object");
		expect(repeated).toEqual(browser);
		expect(retried).toEqual(browser); // A retried commit may receive another conversation ID: no new kab dir.
		expect(installs).toBe(1);
		expect(discoveries).toBe(1);
		expect(await readdir(join(fixture.root, "tools/browser-workers"))).toHaveLength(1);
		insideCommit = false;
		expect(await service.ensureReady()).toBe(availability);
		expect(installs).toBe(1);
		expect(discoveries).toBe(1);
	} finally {
		finish();
		await service.cleanup("project", 21, true);
		await service.cleanup("project", 22, true);
		await rm(fixture.root, { recursive: true, force: true });
	}
});

test("failed ensureReady passes a plain unavailable reason into prepare without an in-commit retry", async () => {
	const fixture = await createFixture();
	let installs = 0;
	const service = new WorkerBrowserService({ ...fixture.options, installer: { ensure: async () => { installs++; throw new Error("offline"); } } });
	try {
		const availability = await service.ensureReady();
		expect(availability).toBe("agent-browser setup failed: offline");
		for (const id of [1, 1, 2]) {
			const prepared = await service.prepare("project", id, availability, "failed-spawn-call");
			expect(workerBrowserInstructions(prepared)).toBe("Browser unavailable: agent-browser setup failed: offline");
		}
		expect(installs).toBe(1);
		expect(await readdir(join(fixture.root, "tools/browser-workers"))).toEqual([]);
		await service.ensureReady(); // Only a later pre-commit spawn preparation retries.
		expect(installs).toBe(2);
	} finally { await rm(fixture.root, { recursive: true, force: true }); }
});
