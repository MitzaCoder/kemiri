import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_FEATURES, LEGACY_HARNESS_FEATURES, MAX_CHANGE_PATCH_BYTES, MAX_CHANGE_SIDE_BYTES, type ChangeSource } from "@kemiri/protocol";
import { createSetup, TestClient } from "./support.ts";

const byCommit = (hash: string) => ({ kind: "commit", hash } as const);
const byTask = (taskId: string) => ({ kind: "task", taskId } as const);
const task = { title: "Review paper samples", description: "", acceptance: null, status: "todo" as const, blockedBy: [], blockedReason: null, writeScopes: [] };
const identity = { GIT_AUTHOR_NAME: "Sample Author", GIT_COMMITTER_NAME: "Sample Author", GIT_AUTHOR_EMAIL: "author@example.test",
	GIT_COMMITTER_EMAIL: "author@example.test", GIT_AUTHOR_DATE: "2025-01-02T03:04:05Z", GIT_COMMITTER_DATE: "2025-01-02T03:04:05Z" };

function git(path: string, ...args: string[]): string {
	const command = Bun.spawnSync(["git", "-C", path, ...args], { env: { ...process.env, ...identity } });
	if (command.exitCode !== 0) throw new Error(command.stderr.toString());
	return command.stdout.toString().trim();
}

async function withChanges(work: (fixture: {
	root: string; git(...args: string[]): string; write(path: string, text: string | Uint8Array): Promise<void>;
	commit(subject: string): string; projectId: string; list(source: ChangeSource): ReturnType<TestClient["request"]>;
	file(source: ChangeSource, path: string): ReturnType<TestClient["request"]>;
	client: TestClient; setup: Awaited<ReturnType<typeof createSetup>>;
}) => Promise<void>, options: { disabled?: boolean; init?: (path: string) => void; authRequired?: boolean } = {}) {
	const setup = await createSetup({
		...(options.disabled ? { features: HARNESS_FEATURES.filter(feature => feature !== "project-changes") } : {}),
		...(options.authRequired ? { auth: { mode: "required" } } : {}),
	});
	const root = setup.projectDir;
	const run = (...args: string[]) => git(root, ...args);
	const client = await TestClient.open(setup.server);
	try {
		await rm(join(root, "README.md"));
		if (options.init) options.init(root); else run("init", "-b", "main");
		const { id: projectId } = await setup.server.manager.store.add(root);
		if (!options.authRequired) {
			const hello = await client.hello();
			expect(hello.type === "hello" && hello.features?.includes("project-changes")).toBe(!options.disabled);
		}
		await work({ root, git: run, write: (path, text) => writeFile(join(root, path), text), projectId, client, setup,
			commit: (subject) => { run("add", "-A"); run("commit", "-m", subject); return run("rev-parse", "HEAD"); },
			list: source => client.request({ type: "changes.list", projectId, source }),
			file: (source, path) => client.request({ type: "changes.file", projectId, source, path }),
		});
	} finally { client.close(); await setup.cleanup(); }
}

const changed = (path: string, status: string, additions: number, deletions: number, binary = false) => ({ path, status, additions, deletions, binary });

test("project changes describe root, added, modified, deleted, renamed and binary files without reading the checkout", async () => {
	await withChanges(async ({ root, write, git, commit, list, file }) => {
		await write("old.txt", "rename me\nkeep this line\n");
		await write("remove.txt", "gone\n");
		await write("change.txt", "earlier\n");
		const base = commit("Set up paper samples");
		const earlierHash = git("rev-parse", "HEAD:change.txt");
		expect(await file(byCommit(base), "change.txt")).toEqual({ type: "changes.file", id: expect.any(String), after: { text: "earlier\n", hash: earlierHash } });
		git("mv", "old.txt", "new\tname.txt");
		await rm(join(root, "remove.txt"));
		await write("change.txt", "later\r\n\n");
		await write("odd\nname.txt", "sample\n");
		await write("binary.bin", new Uint8Array([0, 1, 2]));
		await write("invalid-utf8.txt", new Uint8Array([0xff]));
		await symlink("/outside/example.txt", join(root, "link.txt"));
		const hash = commit("Update paper samples");
		const laterHash = git("rev-parse", "HEAD:change.txt");
		await write("change.txt", "uncommitted\n");
		const summary = await list(byCommit(hash.toUpperCase()));
		expect(summary).toMatchObject({ type: "changes.list", truncated: false,
			commits: [{ hash, subject: "Update paper samples", author: "Sample Author", landed: true }],
		});
		if (summary.type !== "changes.list") throw new Error(JSON.stringify(summary));
		expect(new Date(summary.commits[0]!.time).toISOString()).toBe("2025-01-02T03:04:05.000Z");
		expect(summary.files).toEqual(expect.arrayContaining([
			changed("odd\nname.txt", "added", 1, 0), changed("change.txt", "modified", 2, 1), changed("remove.txt", "deleted", 0, 1),
			{ ...changed("new\tname.txt", "renamed", 0, 0), previousPath: "old.txt" }, changed("binary.bin", "added", 0, 0, true),
			changed("link.txt", "added", 0, 0, true),
		]));
		expect(await file(byCommit(hash), "change.txt")).toEqual({ type: "changes.file", id: expect.any(String),
			before: { text: "earlier\n", hash: earlierHash }, after: { text: "later\r\n\n", hash: laterHash } });
		expect(await file(byCommit(hash), "remove.txt")).toMatchObject({ type: "changes.file", before: { text: "gone\n" } });
		expect(await file(byCommit(hash), "new\tname.txt")).toMatchObject({ type: "changes.file", before: { text: "rename me\nkeep this line\n" }, after: { text: "rename me\nkeep this line\n" } });
		for (const path of ["binary.bin", "invalid-utf8.txt", "link.txt"]) {
			expect(await file(byCommit(hash), path)).toEqual({ type: "changes.file", id: expect.any(String), binary: true });
		}
		expect(await readFile(join(root, "change.txt"), "utf8")).toBe("uncommitted\n");
	});
});

test("first-parent merge and task diffs share the current Delivery commit set", async () => {
	await withChanges(async ({ write, git, commit, list, file, setup, projectId, client }) => {
		await write("changes.txt", "base\n");
		const base = commit("Baseline");
		const { runtime } = await setup.server.manager.open(projectId);
		for (let i = 0; i < 3; i++) await runtime.board.saveTask({ task }, "harness");
		git("switch", "-c", "work");
		await write("changes.txt", "one\n");
		const first = commit("First task commit");
		await write("changes.txt", "two\n");
		const second = commit("Second task commit");
		await write("separate.txt", "belongs elsewhere\n");
		commit("Intervening work");
		await write("changes.txt", "three\n");
		const third = commit("Third task commit");
		await runtime.taskChanges.declareChanges([second, first], ["T1"], "manual");
		await runtime.taskChanges.declareChanges([third], ["T1"], "manual");
		const delivery = await client.request({ type: "board.task.timeline", projectId, taskId: "T1", delivery: true });
		const scattered = await list(byTask("T1"));
		expect(scattered).toMatchObject({ type: "changes.list", files: [], contiguous: false, nonContiguousReason: "not-first-parent-chain" });
		if (scattered.type !== "changes.list" || delivery.type !== "board.task.timeline" || !delivery.delivery) throw new Error("Expected task responses");
		expect(scattered.commits.map(commit => commit.hash).sort()).toEqual(delivery.delivery.commits.slice().sort());
		expect(scattered.commits.every(commit => !commit.landed)).toBe(true);
		expect(await file(byTask("T1"), "changes.txt")).toMatchObject({ type: "error", error: { code: "bad_request" } });
		expect(await file(byCommit(third), "changes.txt")).toMatchObject({ type: "changes.file", before: { text: "two\n" }, after: { text: "three\n" } });
		await runtime.taskChanges.declareChanges([second, first], ["T2"], "manual");
		expect(await list(byTask("T2"))).toMatchObject({ type: "changes.list", contiguous: true,
			commits: [{ hash: first }, { hash: second }], files: [changed("changes.txt", "modified", 1, 1)] });
		expect(await file(byTask("T2"), "changes.txt")).toMatchObject({ type: "changes.file", before: { text: "base\n" }, after: { text: "two\n" } });
		expect(await list(byTask("T3"))).toMatchObject({ type: "changes.list", commits: [], files: [], contiguous: false, nonContiguousReason: "no-commits" });
		expect(await list(byTask("T9"))).toMatchObject({ type: "error", error: { code: "unknown_task" } });

		git("switch", "main");
		await write("main-only.txt", "first parent\n");
		const main = commit("Advance main");
		git("merge", "--no-ff", "work", "-m", "Merge paper samples");
		const merge = git("rev-parse", "HEAD");
		expect(git("rev-parse", "HEAD^1")).toBe(main);
		expect(git("rev-parse", "HEAD^^")).toBe(base);
		expect(await list(byCommit(merge))).toMatchObject({ type: "changes.list", commits: [{ hash: merge, landed: true }],
			files: [changed("changes.txt", "modified", 1, 1), changed("separate.txt", "added", 1, 0)] });
		expect(await file(byCommit(merge), "changes.txt")).toMatchObject({ type: "changes.file", before: { text: "base\n" }, after: { text: "three\n" } });
		expect(await list(byTask("T2"))).toMatchObject({ type: "changes.list", commits: [{ landed: true }, { landed: true }] });
	});
}, 30_000);

test("file and patch byte limits preserve text at exactly one MiB and exclude directory replacements", async () => {
	await withChanges(async ({ root, write, git, commit, file }) => {
		const line = "0123456789abcdef\n";
		await write("limit.txt", "x".repeat(MAX_CHANGE_SIDE_BYTES));
		await write("big.txt", line.repeat(Math.ceil(MAX_CHANGE_SIDE_BYTES / line.length)) + "before\n");
		await write("replaced", line.repeat(Math.ceil(MAX_CHANGE_SIDE_BYTES / line.length)));
		const base = commit("Store large samples");
		const atLimit = await file(byCommit(base), "limit.txt");
		expect(atLimit.type === "changes.file" && atLimit.after?.text.length).toBe(MAX_CHANGE_SIDE_BYTES);
		await write("big.txt", line.repeat(Math.ceil(MAX_CHANGE_SIDE_BYTES / line.length)) + "after\n");
		await rm(join(root, "replaced"));
		await mkdir(join(root, "replaced"));
		await write("replaced/unrelated.txt", "unrelated sample\n");
		const hash = commit("Update large samples");
		expect(await file(byCommit(hash), "big.txt")).toMatchObject({ type: "changes.file", tooLarge: true,
			patch: expect.stringContaining("-before\n+after\n") });
		const deleted = await file(byCommit(hash), "replaced");
		expect(deleted).toMatchObject({ type: "changes.file", tooLarge: true, patchTruncated: true });
		if (deleted.type !== "changes.file" || deleted.patch === undefined) throw new Error("Expected patch prefix");
		expect(Buffer.byteLength(deleted.patch)).toBeLessThanOrEqual(MAX_CHANGE_PATCH_BYTES);
		expect(deleted.patch).toContain("deleted file mode");
		expect(deleted.patch).not.toContain("unrelated");
		expect(deleted.before).toBeUndefined(); expect(deleted.after).toBeUndefined();
		git("mv", "big.txt", "renamed.txt");
		await write("renamed.txt", line.repeat(Math.ceil(MAX_CHANGE_SIDE_BYTES / line.length)) + "renamed\n");
		const renamed = commit("Rename the large sample");
		expect(await file(byCommit(renamed), "renamed.txt")).toMatchObject({ type: "changes.file", tooLarge: true,
			patch: expect.stringContaining("-after\n+renamed\n") });
	});
});

test("changes lists cap files at 500 and allow direct lookup beyond the cap", async () => {
	await withChanges(async ({ write, commit, list, file }) => {
		await Promise.all(Array.from({ length: 501 }, (_, index) => write(`sample-${String(index).padStart(3, "0")}.txt`, "sample\n")));
		const source = byCommit(commit("Store a catalog of samples"));
		const summary = await list(source);
		expect(summary).toMatchObject({ type: "changes.list", truncated: true });
		expect(summary.type === "changes.list" && summary.files.length).toBe(500);
		expect(await file(source, "sample-500.txt")).toMatchObject({ type: "changes.file", after: { text: "sample\n" } });
	});
});

test("changes rejects bad objects, unsafe paths, and requests outside the project's Git store", async () => {
	await withChanges(async ({ root, git, write, commit, list, file, setup, client }) => {
		await mkdir(join(root, ".jj"));
		await write(".jj/hidden.txt", "metadata\n");
		await write(":(glob)*", "literal path\n");
		const hash = commit("Store literal paths");
		const source = byCommit(hash);
		const blob = git("rev-parse", "HEAD::(glob)*");
		git("update-ref", `refs/heads/${"a".repeat(40)}`, hash);
		for (const bad of ["--help", "HEAD", hash.slice(0, 12), hash + "^", "a".repeat(41)]) {
			expect(await list(byCommit(bad))).toMatchObject({ type: "error", error: { code: "bad_request" } });
		}
		for (const missing of [blob, "a".repeat(40), "b".repeat(64)]) {
			expect(await list(byCommit(missing))).toMatchObject({ type: "error", error: { code: "not_found" } });
		}
		for (const path of ["../outside.txt", "/etc/example.txt", "C:/outside.txt", "a\\b", "a\0b", "a/../b", ".git/config", ".jj/hidden.txt", "folder/.GiT/config", "é".repeat(2100)]) {
			expect(await file(source, path)).toMatchObject({ type: "error", error: { code: "invalid_path" } });
		}
		expect(await list(source)).toMatchObject({ type: "changes.list", files: [changed(":(glob)*", "added", 1, 0)] });
		expect(await file(source, ":(glob)*")).toMatchObject({ type: "changes.file", after: { text: "literal path\n" } });
		await mkdir(join(root, "nested"));
		const nested = await setup.server.manager.store.add(join(root, "nested"));
		expect(await client.request({ type: "changes.list", projectId: nested.id, source })).toMatchObject({ type: "error", error: { code: "not_found" } });
		expect(await client.request({ type: "changes.list", projectId: "missing-project", source })).toMatchObject({ type: "error", error: { code: "unknown_project" } });
	});
});

test("the project-changes capability is not part of legacy defaults and can disable both requests", async () => {
	expect(LEGACY_HARNESS_FEATURES).not.toContain("project-changes");
	await withChanges(async ({ list, file }) => {
		const source = byCommit("a".repeat(40));
		for (const reply of [await list(source), await file(source, "sample.txt")]) {
			expect(reply).toMatchObject({ type: "error", error: { code: "unknown_request" } });
		}
	}, { disabled: true });
});

test("changes requests inherit required WebSocket device auth", async () => {
	await withChanges(async ({ list }) => {
		expect(await list(byCommit("a".repeat(40)))).toMatchObject({ type: "error", error: { code: "auth_required" } });
	}, { authRequired: true });
});

test("SHA-256 Git repositories use full 64-character commit and blob hashes", async () => {
	await withChanges(async ({ write, commit, list, file }) => {
		await write("sample.txt", "SHA-256 sample\n");
		const hash = commit("Store a sample");
		expect(hash.length).toBe(64);
		expect(await list(byCommit(hash))).toMatchObject({ type: "changes.list", commits: [{ hash, landed: true }] });
		expect(await file(byCommit(hash), "sample.txt")).toMatchObject({ type: "changes.file", after: { text: "SHA-256 sample\n", hash: expect.stringMatching(/^[a-f\d]{64}$/) } });
	}, { init: root => { git(root, "init", "-b", "main", "--object-format=sha256"); } });
});

const testWithJj = Bun.which("jj") ? test : test.skip;
testWithJj("a non-colocated Git-backed jj project's changes leave the working copy and operation log untouched", async () => {
	function jj(root: string, ...args: string[]) {
		const result = Bun.spawnSync(["jj", "--no-pager", "-R", root, "--config=user.name='Sample Author'", "--config=user.email='author@example.test'", ...args]);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	}
	await withChanges(async ({ root, write, list, file, setup, client }) => {
		await write("sample.txt", "committed sample\n");
		jj(root, "commit", "-m", "Store a sample");
		const hash = jj(root, "--ignore-working-copy", "log", "--no-graph", "-r", "@-", "-T", "commit_id");
		await write("sample.txt", "uncommitted sample\n");
		const before = jj(root, "--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id");
		expect(await list(byCommit(hash))).toMatchObject({ type: "changes.list", commits: [{ hash, landed: false }], files: [changed("sample.txt", "added", 1, 0)] });
		expect(await file(byCommit(hash), "sample.txt")).toMatchObject({ type: "changes.file", after: { text: "committed sample\n" } });
		expect(jj(root, "--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id")).toBe(before);
		expect(await readFile(join(root, "sample.txt"), "utf8")).toBe("uncommitted sample\n");

		const linkedPath = join(root, "..", "linked-samples");
		jj(root, "workspace", "add", linkedPath);
		const linkedProject = await setup.server.manager.store.add(linkedPath);
		expect(await client.request({ type: "changes.file", projectId: linkedProject.id, source: byCommit(hash), path: "sample.txt" }))
			.toMatchObject({ type: "changes.file", after: { text: "committed sample\n" } });
	}, { init: root => {
		const result = Bun.spawnSync(["jj", "git", "init", "--no-colocate", root]);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	} });
});

test("slow Git commands time out without exposing process output", async () => {
	const tools = await mkdtemp(join(tmpdir(), "changes-git-"));
	try {
		const sleep = Bun.which("sleep");
		if (!sleep) throw new Error("Test requires sleep");
		await writeFile(join(tools, "git"), `#!/bin/sh\nprintf 'private subprocess output\\n' >&2\nexec '${sleep}' 30\n`, { mode: 0o700 });
		// Use a child so changing PATH cannot affect the running test server or other tests.
		const child = Bun.spawn([process.execPath, "-e", `
			import { ProjectChanges } from "./packages/server/src/project-changes.ts";
			try { await new ProjectChanges(process.cwd(), undefined, async () => new Map()).list({ kind: "commit", hash: "a".repeat(40) }); }
			catch (error) { console.log(JSON.stringify({ code: error.code, message: error.message })); }
		`], { env: { ...process.env, PATH: `${tools}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect(exit).toBe(0); expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toEqual({ code: "harness_failed", message: "Git change read timed out" });
	} finally { await rm(tools, { recursive: true, force: true }); }
}, 20_000);

test("request Changes and Delivery gather nested commits without double counting", async () => {
 await withChanges(async ({ write, commit, list, setup, projectId, client }) => {
  await write("samples.txt", "base\n"); commit("Start a sample catalogue");
  const { runtime } = await setup.server.manager.open(projectId);
  for (const parent of [undefined, "T1", "T2"]) {
   await runtime.board.saveTask({ task: { ...task, ...(parent ? { parent } : {}) } }, "harness");
  }
  await write("samples.txt", "Labels\n"); const shared = commit("Add labels");
  await write("samples.txt", "Labels and cartons\n"); const nested = commit("Add cartons");
  await runtime.taskChanges.declareChanges([shared], ["T1", "T2", "T3"], "manual");
  await runtime.taskChanges.declareChanges([nested], ["T3"], "manual");
  const capable = await TestClient.open(setup.server);
  try {
   await capable.request({ type: "hello", protocolVersion: 1, client: { name: "test", version: "0", features: ["request-digest"] } });
   const changes = { type: "changes.list", projectId, source: byTask("T1") } as const;
   const delivery = { type: "board.task.timeline", projectId, taskId: "T1", delivery: true } as const;
   const before = await list(byTask("T1"));
   if (before.type !== "changes.list") throw Error("Expected Changes");
   expect(before.commits.map(({ hash, partIds }) => [hash, partIds])).toEqual([[shared, undefined]]);
   expect(await client.request(delivery)).toMatchObject({ delivery: { commits: [shared], integration: { landed: 1 } } });
   expect(await capable.request(changes)).toMatchObject({ type: "changes.list", contiguous: true, commits: [
    { hash: shared, partIds: ["T2", "T3"] }, { hash: nested, partIds: ["T3"] },
   ] });
   expect(await capable.request(delivery)).toMatchObject({ delivery: { commits: [shared, nested], integration: { landed: 2 },
    partCommits: [{ partId: "T2", commits: [shared] }, { partId: "T3", commits: [shared, nested] }],
   } });
   expect(await capable.request({ ...changes, type: "changes.file", path: "samples.txt" })).toMatchObject({ after: { text: "Labels and cartons\n" } });
   expect(await capable.request({ ...changes, source: byTask("T2") })).toMatchObject({ commits: [{ hash: shared }] });
  } finally { capable.close(); }
 });
}, 20_000);
