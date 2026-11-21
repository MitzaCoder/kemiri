import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { HARNESS_FEATURES, LEGACY_HARNESS_FEATURES, MAX_CHANGE_PATCH_BYTES, MAX_CHANGE_SIDE_BYTES, type CodeRoot } from "@kemiri/protocol";
import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ThreadsDoc } from "../src/threads.ts";
import { WorkersDoc } from "../src/workers.ts";
import { createSetup, TestClient } from "./support.ts";

const project: CodeRoot = { kind: "project" };
const error = (code: string) => ({ type: "error", error: { code } });
const identity = { GIT_AUTHOR_NAME: "Sample Author", GIT_COMMITTER_NAME: "Sample Author", GIT_AUTHOR_EMAIL: "sample@example.test", GIT_COMMITTER_EMAIL: "sample@example.test" };
const jjAvailable = Bun.which("jj") !== null;

function command(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(args, { cwd, env: { ...process.env, ...identity } });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

function initGit(cwd: string): void { command(cwd, "git", "init", "-q"); }
async function commitBase(cwd: string): Promise<string> {
	await writeFile(join(cwd, "sample.txt"), "before\n");
	command(cwd, "git", "add", "sample.txt");
	command(cwd, "git", "commit", "-qm", "Paper samples");
	return command(cwd, "git", "rev-parse", "HEAD");
}

async function withServer(work: (sample: {
	setup: Awaited<ReturnType<typeof createSetup>>; client: TestClient; projectId: string; root: string;
	list(root?: CodeRoot): ReturnType<TestClient["request"]>;
	file(path: string, reveal?: boolean, root?: CodeRoot): ReturnType<TestClient["request"]>;
}) => Promise<void>, options?: Parameters<typeof createSetup>[0]) {
	const setup = await createSetup(options);
	const root = setup.projectDir;
	const client = await TestClient.open(setup.server);
	try {
		await rm(join(root, "README.md"));
		const { id: projectId } = await setup.server.manager.store.add(root);
		const hello = await client.hello();
		expect(hello.type === "hello" && hello.features?.includes("project-changes-working")).toBe(options?.projectFiles !== false && (!options?.features || options.features.includes("project-changes-working")));
		const source = (root: CodeRoot) => ({ kind: "working", root });
		await work({ setup, client, projectId, root,
			list: (root = project) => client.request({ type: "changes.list", projectId, source: source(root) }),
			file: (path, reveal, root = project) => client.request({ type: "changes.file", projectId, source: source(root), path, reveal }),
		});
	} finally { client.close(); await setup.cleanup(); }
}

async function repositoryState(gitDir: string) {
	const index = join(gitDir, "index");
	const info = await stat(index).catch(() => undefined);
	return {
		index: info && { bytes: await readFile(index), mtime: info.mtimeMs },
		refs: command(gitDir, "git", `--git-dir=${gitDir}`, "show-ref", "--head"),
		objects: command(gitDir, "git", `--git-dir=${gitDir}`, "count-objects", "-v"),
		directory: (await readdir(gitDir)).sort(),
	};
}

test("working changes compare disk to Git HEAD without changing the index, objects, or refs", async () => {
	await withServer(async ({ setup, root, list, file }) => {
		initGit(root);
		const put = (path: string, text: string | Uint8Array) => writeFile(join(root, path), text);
		await put(".gitattributes", "edited.txt filter=sample\n");
		await put(".gitignore", "ignored.txt\n");
		await put("edited.txt", "old\n");
		await put("deleted.txt", "goodbye\n");
		await put("rename-old.txt", "one\ntwo\nthree\nfour\n");
		await put(".env.sample", "BEFORE=paper\n");
		await put("id_clean", "unchanged\n");
		await put("unchanged.bin", Uint8Array.of(0, 1));
		await put("large.txt", `old\n${"line\n".repeat(MAX_CHANGE_SIDE_BYTES / 4)}`);
		await put("unchanged-large.txt", "line\n".repeat(MAX_CHANGE_SIDE_BYTES / 4));
		command(root, "git", "add", "--all");
		command(root, "git", "commit", "-qm", "Paper samples");
		const baseCommit = command(root, "git", "rev-parse", "HEAD");
		await put("edited.txt", "staged\n");
		command(root, "git", "add", "edited.txt");
		await put("edited.txt", "live\nnext\n");
		await put(".env.sample", "AFTER=paper\n");
		await put("ignored.txt", "do not list\n");
		await put("binary.dat", Uint8Array.of(0, 1, 2));
		await put("large.txt", `new\n${"line\n".repeat(MAX_CHANGE_SIDE_BYTES / 4)}`);
		await put("added.txt", "staged add\n");
		command(root, "git", "add", "added.txt");
		await put("odd\nuntracked.txt", "new file\n");
		await rm(join(root, "deleted.txt"));
		await rename(join(root, "rename-old.txt"), join(root, "rename-new.txt"));
		const outside = join(setup.root, "outside.txt");
		await writeFile(outside, "Outside checkout\n");
		await symlink(outside, join(root, "escape.txt"));
		// A configured clean filter must not run while the backend inspects the work tree.
		const marker = join(setup.root, "clean-filter-ran");
		command(root, "git", "config", "filter.sample.clean", `touch '${marker}'; cat`);
		const previous = await repositoryState(join(root, ".git"));
		const reply = await list();
		expect(reply).toMatchObject({ type: "changes.list", baseCommit, readAt: expect.any(String), commits: [], truncated: false });
		if (reply.type !== "changes.list") throw new Error(JSON.stringify(reply));
		expect(reply.files).toEqual([
			{ path: ".env.sample", status: "modified", additions: 0, deletions: 0, binary: false },
			{ path: "added.txt", status: "added", additions: 1, deletions: 0, binary: false },
			{ path: "binary.dat", status: "added", additions: 0, deletions: 0, binary: true },
			{ path: "deleted.txt", status: "deleted", additions: 0, deletions: 1, binary: false },
			{ path: "edited.txt", status: "modified", additions: 2, deletions: 1, binary: false },
			{ path: "escape.txt", status: "added", additions: 0, deletions: 0, binary: true },
			{ path: "large.txt", status: "modified", additions: 0, deletions: 0, binary: false },
			{ path: "odd\nuntracked.txt", status: "added", additions: 1, deletions: 0, binary: false },
			{ path: "rename-new.txt", previousPath: "rename-old.txt", status: "renamed", additions: 0, deletions: 0, binary: false },
		]);
		expect(await file("edited.txt")).toMatchObject({ before: { text: "old\n" }, after: { text: "live\nnext\n" } });
		expect(await file("deleted.txt")).toMatchObject({ before: { text: "goodbye\n" } });
		expect(await file("rename-new.txt")).toMatchObject({ before: { text: "one\ntwo\nthree\nfour\n" }, after: { text: "one\ntwo\nthree\nfour\n" } });
		expect(await file("binary.dat")).toMatchObject({ binary: true });
		expect(await file(".env.sample")).toMatchObject({ sensitive: true });
		expect(await file(".env.sample", true)).toMatchObject({ before: { text: "BEFORE=paper\n" }, after: { text: "AFTER=paper\n" } });
		for (const path of ["../outside.txt", "escape.txt", ".git/index", ".jj/repo"]) expect(await file(path)).toMatchObject(error("invalid_path"));
		const large = await file("large.txt");
		expect(large).toMatchObject({ tooLarge: true, patchTruncated: true });
		if (large.type !== "changes.file") throw new Error(JSON.stringify(large));
		expect(large.patch).toContain("-old\n+new\n");
		expect(Buffer.byteLength(large.patch ?? "")).toBeLessThanOrEqual(MAX_CHANGE_PATCH_BYTES);
		expect(await file("ignored.txt")).toMatchObject(error("not_found"));
		expect(await stat(marker).catch(() => undefined)).toBeUndefined();
		expect(await repositoryState(join(root, ".git"))).toEqual(previous);
	}, undefined);
}, 20_000);

for (const layout of ["colocated", "linked"] as const) test.skipIf(!jjAvailable)(`live changes use the parent of a ${layout} jj workspace without snapshotting`, async () => {
	await withServer(async ({ setup, client, root }) => {
		command(root, "jj", "git", "init", layout === "colocated" ? "--colocate" : "--no-colocate");
		await writeFile(join(root, "sample.txt"), "parent\n");
		command(root, "jj", "commit", "-m", "Paper samples");
		const gitDir = layout === "colocated" ? join(root, ".git") : join(root, ".jj", "repo", "store", "git");
		const checkout = layout === "colocated" ? root : join(setup.root, "linked-checkout");
		if (layout === "linked") command(root, "jj", "workspace", "add", "-r", "@-", checkout);
		await writeFile(join(checkout, "sample.txt"), "snapshot\n");
		command(checkout, "jj", "status");
		const baseCommit = command(checkout, "jj", "--ignore-working-copy", "--at-op=@", "log", "--no-graph", "-r", "@-", "-T", "commit_id");
		const opHead = () => command(checkout, "jj", "--ignore-working-copy", "--at-op=@", "op", "log", "--no-graph", "-n", "1", "-T", "id");
		const op = opHead();
		await writeFile(join(checkout, "sample.txt"), "live, not snapped\n");
		await writeFile(join(checkout, "new.txt"), "another page\n");
		const previous = await repositoryState(gitDir);
		const { id: projectId } = await setup.server.manager.store.add(checkout);
		const source = { kind: "working", root: project };
		expect(await client.request({ type: "changes.list", projectId, source })).toMatchObject({ type: "changes.list", baseCommit,
			files: [{ path: "new.txt", status: "added" }, { path: "sample.txt", status: "modified" }], truncated: false });
		expect(await client.request({ type: "changes.file", projectId, source, path: "sample.txt" })).toMatchObject({ before: { text: "parent\n" }, after: { text: "live, not snapped\n" } });
		expect(opHead()).toBe(op);
		expect(await repositoryState(gitDir)).toEqual(previous);
	});
});

test("working changes resolve worker and thread checkouts and reject missing roots", async () => {
	await withServer(async ({ setup, projectId, list, file }) => {
		const worker = join(setup.root, "sample-worker");
		const thread = join(setup.root, "sample-thread");
		const model = { provider: "faux", modelId: "faux" };
		const at = new Date().toISOString();
		for (const [path, text] of [[worker, "Worker copy"], [thread, "Thread copy"]] as const) {
			await mkdir(path);
			initGit(path);
			await commitBase(path);
			await writeFile(join(path, "sample.txt"), text);
		}
		const { runtime } = await setup.server.manager.open(projectId);
		await runtime.harness.commit(async tx => {
			const workers = await tx.doc(WorkersDoc, runtime.conversation.id);
			workers.workers.papers = { id: "papers", title: "Paper samples", conversationId: 42, workspacePath: worker, model, isolation: "workspace",
				status: "done", thinkingLevel: null, spawnedByCallId: null, anchorTaskId: 42, createdAt: at, updatedAt: at, lastReport: null, failure: null };
			const threads = await tx.doc(ThreadsDoc, runtime.conversation.id);
			threads.threads.papers = { id: "papers", title: "Paper samples", brief: "Read sample files", startedBy: "main", conversationId: 43, anchorTaskId: 43, scheduleId: null, startedByKey: "sample",
				model, thinkingLevel: null, onFinish: "record", status: "done", summary: null, failure: null, createdAt: at, updatedAt: at,
				finishedAt: at, archived: false, autoArchive: false, checkout: thread, checkoutKind: "directory" };
		}, BACKGROUND_CONTEXT);
		const roots = [{ kind: "worker", workerId: "papers" }, { kind: "thread", threadId: "papers" }] as const;
		expect(await list(roots[0])).toMatchObject({ files: [{ path: "sample.txt", status: "modified" }] });
		expect(await file("sample.txt", false, roots[0])).toMatchObject({ after: { text: "Worker copy" } });
		expect(await file("sample.txt", false, roots[1])).toMatchObject({ after: { text: "Thread copy" } });
		await rm(worker, { recursive: true });
		await rm(thread, { recursive: true });
		for (const root of roots) expect(await list(root)).toMatchObject(error("not_found"));
		expect(await list()).toMatchObject(error("not_found"));
	});
});

test("unborn Git checkouts list at most 500 changes against an empty base", async () => {
	await withServer(async ({ root, list }) => {
		initGit(root);
		for (let start = 0; start < 525; start += 25) await Promise.all(Array.from({ length: 25 }, (_, offset) =>
			writeFile(join(root, `note-${start + offset}.txt`), "paper\n")));
		const response = await list();
		expect(response).toMatchObject({ type: "changes.list", baseCommit: null, truncated: true });
		expect(response.type === "changes.list" && response.files).toHaveLength(500);
	});
});

for (const options of [{ projectFiles: false }, { features: HARNESS_FEATURES.filter(feature => feature !== "project-changes-working") }]) {
	test(`working sources are unavailable with ${Object.keys(options)[0]} disabled, but commit reads still work`, async () => {
		expect(LEGACY_HARNESS_FEATURES).not.toContain("project-changes-working");
		await withServer(async ({ root, client, list, file, projectId }) => {
			initGit(root);
			const hash = await commitBase(root);
			expect(await list()).toMatchObject(error("unknown_request"));
			expect(await file("sample.txt")).toMatchObject(error("unknown_request"));
			expect(await client.request({ type: "changes.list", projectId, source: { kind: "commit", hash } })).toMatchObject({ type: "changes.list" });
		}, options);
	});
}
