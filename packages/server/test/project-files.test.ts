import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LEGACY_HARNESS_FEATURES, MAX_FILE_BYTES, type CodeRoot } from "@kemiri/protocol";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectFilesEnabled } from "../src/project-files.ts";
import { ThreadsDoc } from "../src/threads.ts";
import { WorkersDoc } from "../src/workers.ts";
import { createSetup, TestClient } from "./support.ts";

const projectRoot: CodeRoot = { kind: "project" };
const denied = (code: string) => ({ type: "error", error: { code } });

function command(path: string, ...argv: string[]): string {
	const process = Bun.spawnSync(argv, { cwd: path });
	if (process.exitCode !== 0) throw new Error(process.stderr.toString());
	return process.stdout.toString().trim();
}

async function fixture(work: (sample: {
	root: string; setup: Awaited<ReturnType<typeof createSetup>>; client: TestClient; projectId: string;
	write(path: string, content?: string | Uint8Array): Promise<void>;
	list(path?: string, showHidden?: boolean, root?: CodeRoot): ReturnType<TestClient["request"]>;
	search(query: string, root?: CodeRoot): ReturnType<TestClient["request"]>;
	read(path: string, reveal?: boolean, root?: CodeRoot): ReturnType<TestClient["request"]>;
}) => Promise<void>, options?: Parameters<typeof createSetup>[0]) {
	const setup = await createSetup(options);
	const root = setup.projectDir;
	const client = await TestClient.open(setup.server);
	try {
		await rm(join(root, "README.md"));
		const { id: projectId } = await setup.server.manager.store.add(root);
		if (options?.auth?.mode !== "required") {
			const hello = await client.hello();
			expect(hello.type === "hello" && hello.features?.includes("project-files")).toBe(options?.projectFiles !== false);
		}
		await work({ root, setup, client, projectId,
			write: (path, content = "Paper sample\n") => writeFile(join(root, path), content),
			list: (path = "", showHidden, root = projectRoot) => client.request({ type: "files.list", projectId, root, path, showHidden }),
			search: (query, root = projectRoot) => client.request({ type: "files.search", projectId, root, query }),
			read: (path, reveal, root = projectRoot) => client.request({ type: "files.read", projectId, root, path, reveal }),
		});
	} finally { client.close(); await setup.cleanup(); }
}

function entryNames(reply: Awaited<ReturnType<TestClient["request"]>>): string[] {
	if (reply.type !== "files.list") throw new Error(JSON.stringify(reply));
	return reply.entries.map(entry => entry.name);
}

test("project files list Git-visible entries, sorting directories first without dereferencing links", async () => {
	await fixture(async ({ root, setup, list, search, write }) => {
		command(root, "git", "init", "-q");
		await write(".gitignore", "ignored/\n*.skip\n");
		for (const dir of ["visible", "ignored", "visible/.jj", ".jj"]) await mkdir(join(root, dir));
		for (const path of ["sample.txt", "visible/sample-notes.txt", "ignored/sample.txt", ".sample", "sample.skip", "tracked-sample.skip", ":sample.skip", "sample\nnotes.txt"]) await write(path);
		command(root, "git", "add", "-f", "tracked-sample.skip");
		const outside = join(setup.root, "outside-worktree");
		await mkdir(outside);
		await writeFile(join(outside, "outside-sample.txt"), "Outside the registered checkout");
		command(root, "git", "config", "core.worktree", outside);
		await symlink("visible", join(root, "alias"));
		const normal = await list();
		expect(entryNames(normal)).toEqual(["visible", "alias", "sample\nnotes.txt", "sample.txt", "tracked-sample.skip"]);
		expect(normal).toMatchObject({ truncated: false, entries: expect.arrayContaining([
			{ name: "alias", kind: "link", size: 7, modifiedAt: expect.any(String) },
		]) });
		expect(entryNames(await list("", true))).toEqual(["ignored", "visible", ".gitignore", ".sample", ":sample.skip", "alias", "sample\nnotes.txt", "sample.skip", "sample.txt", "tracked-sample.skip"]);
		expect(entryNames(await list("alias", true))).toEqual(["sample-notes.txt"]);
		expect(await search("sample")).toMatchObject({ paths: ["sample\nnotes.txt", "sample.txt", "tracked-sample.skip", "visible/sample-notes.txt"] });
	});
});

test("paths cannot escape a root, including through file and directory links or metadata aliases", async () => {
	await fixture(async ({ root, list, read, write, setup }) => {
		await mkdir(join(root, ".git"));
		await mkdir(join(root, ".jj"));
		await mkdir(join(root, "inside"));
		await mkdir(join(setup.root, "outside"));
		await writeFile(join(setup.root, "outside", "sample.txt"), "Outside the checkout");
		await write("inside/sample.txt");
		await write(".git/sample.txt");
		await write(".jj/sample.txt");
		await symlink(join(setup.root, "outside", "sample.txt"), join(root, "outside-file"));
		await symlink(join(setup.root, "outside"), join(root, "outside-dir"));
		await symlink(".git", join(root, "metadata"));
		await symlink("inside/sample.txt", join(root, "inside-file"));
		for (const bad of ["../outside/sample.txt", "/outside/sample.txt", "C:/outside/sample.txt", "a\\b", "a\0b", "inside/../inside", ".git/sample.txt", ".jj/sample.txt", "é".repeat(2100), "outside-file", "outside-dir/sample.txt", "metadata/sample.txt"]) {
			expect(await read(bad)).toMatchObject(denied("invalid_path"));
		}
		for (const bad of ["outside-dir", "metadata", "..", ".git", ".jj"]) expect(await list(bad, true)).toMatchObject(denied("invalid_path"));
		expect(await read("inside-file")).toMatchObject({ text: "Paper sample\n" });
		expect(entryNames(await list("", true))).toEqual(["inside", "inside-file", "metadata", "outside-dir", "outside-file"]);
		expect(await read("missing.txt")).toMatchObject(denied("not_found"));
	});
});

test("reads return exact text and byte hash, or markers for large, binary and sensitive files", async () => {
	await fixture(async ({ root, write, read, list }) => {
		const text = "\ufeffExample café\r\n";
		await write("sample.txt", text);
		await write("max.txt", "x".repeat(MAX_FILE_BYTES));
		await write("oversized.txt", "x".repeat(MAX_FILE_BYTES + 1));
		await write("sample.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xd, 0xa, 0x1a, 0xa, 0]));
		await write("invalid.txt", new Uint8Array([0xff]));
		command(root, "mkfifo", "waiting.fifo");
		expect(await read("sample.txt")).toMatchObject({ text, size: Buffer.byteLength(text), modifiedAt: expect.any(String), hash: createHash("sha256").update(text).digest("hex") });
		expect(await read("max.txt")).toMatchObject({ text: expect.any(String), size: MAX_FILE_BYTES });
		for (const [path, marker] of [["oversized.txt", { tooLarge: true, size: MAX_FILE_BYTES + 1 }],
			["sample.png", { binary: true, mimeType: "image/png" }], ["invalid.txt", { binary: true, mimeType: "application/octet-stream" }]] as const) {
			const reply = await read(path);
			expect(reply).toMatchObject(marker);
			expect(reply).not.toHaveProperty("text");
			expect(reply).not.toHaveProperty("hash");
		}
		expect(await read("waiting.fifo")).toMatchObject(denied("bad_request"));
		expect(await read(".")).toMatchObject(denied("bad_request"));
		expect(entryNames(await list())).not.toContain("waiting.fifo");
		const names = [".env.sample", "sample.PEM", "test.key", "id_sample", ".netrc", ".npmrc", "sample-credentials.json"];
		for (const name of names) await write(name);
		await symlink(".env.sample", join(root, "notes.txt"));
		for (const name of [...names, "notes.txt"]) {
			const hidden = await read(name);
			expect(hidden).toMatchObject({ sensitive: true, size: 13 });
			expect(hidden).not.toHaveProperty("text");
			expect((await read(name, true))).toMatchObject({ text: "Paper sample\n" });
		}
	});
});

test("a non-repository uses a bounded walk and caches its inventory", async () => {
	await fixture(async ({ root, list, search, write }) => {
		await mkdir(join(root, "pages"));
		await mkdir(join(root, ".private"));
		await write(".gitignore", "*.skip");
		await write("paper.skip");
		await write("pages/Paper Sample.md");
		await write(".private/paper.txt");
		await symlink("pages", join(root, "alias"));
		for (let i = 0; i < 1050; i += 50) await Promise.all(Array.from({ length: 50 }, (_, offset) => write(`paper-${i + offset}.txt`)));
		const result = await list();
		expect(result).toMatchObject({ truncated: true });
		expect(entryNames(result)).toHaveLength(1000);
		expect(entryNames(result)[0]).toBe("pages");
		expect(await search("papersample")).toMatchObject({ paths: ["pages/Paper Sample.md"] });
		expect(await search("paper.skip")).toMatchObject({ paths: ["paper.skip"] });
		await write("new-entry.txt");
		expect(await search("new-entry")).toMatchObject({ paths: [] });
		const hits = await search("paper");
		expect(hits.type === "files.search" && hits.paths).toHaveLength(50);
	});
});

test("file search caps the Git inventory at 20,000 paths", async () => {
	await fixture(async ({ root, search }) => {
		command(root, "git", "init", "-q");
		const hash = command(root, "git", "hash-object", "-w", "--stdin");
		const input = Array.from({ length: 20_001 }, (_, index) => `100644 ${hash}\tpage-${String(index).padStart(5, "0")}.txt\n`).join("");
		const update = Bun.spawnSync(["git", "update-index", "--index-info"], { cwd: root, stdin: Buffer.from(input) });
		expect(update.exitCode).toBe(0);
		expect(await search("page-19999.txt")).toMatchObject({ paths: ["page-19999.txt"] });
		expect(await search("page-20000.txt")).toMatchObject({ paths: [] });
	});
});

test("a non-colocated Git-backed jj checkout searches without snapshotting or changing its Git index", async () => {
	await fixture(async ({ root, setup, client }) => {
		command(root, "jj", "git", "init", "--no-colocate", ".");
		await writeFile(join(root, "tracked-paper.txt"), "tracked\n");
		command(root, "jj", "status");
		const workspace = join(setup.root, "linked-checkout");
		command(root, "jj", "workspace", "add", "-r", "@", workspace);
		await writeFile(join(workspace, ".gitignore"), "tracked-paper.txt\nignore-paper.txt\n");
		await writeFile(join(workspace, "ignore-paper.txt"), "not searchable\n");
		await writeFile(join(workspace, "new-paper.txt"), "untracked\n");
		const op = () => command(workspace, "jj", "--at-op=@", "op", "log", "--no-graph", "-n", "1", "-T", "id");
		const gitIndex = join(root, ".jj", "repo", "store", "git", "index");
		const indexBefore = await readFile(gitIndex).catch(() => undefined);
		const before = op();
		const { id: projectId } = await setup.server.manager.store.add(workspace);
		expect(await client.request({ type: "files.search", projectId, root: projectRoot, query: "paper" })).toMatchObject({ paths: ["new-paper.txt", "tracked-paper.txt"] });
		expect(entryNames(await client.request({ type: "files.list", projectId, root: projectRoot, path: "" }))).toEqual(["new-paper.txt", "tracked-paper.txt"]);
		expect(op()).toBe(before);
		expect(await readFile(gitIndex).catch(() => undefined)).toEqual(indexBefore);
	});
});

test("worker and background-thread roots use this project's durable checkout records", async () => {
	await fixture(async ({ projectId, setup, read }) => {
		const worker = join(setup.root, "sample-worker");
		const thread = join(setup.root, "sample-thread");
		const model = { provider: "faux", modelId: "faux" };
		const at = new Date().toISOString();
		for (const [path, text] of [[worker, "Worker copy"], [thread, "Thread copy"]] as const) {
			await mkdir(path);
			await writeFile(join(path, "sample.txt"), text);
		}
		const { runtime } = await setup.server.manager.open(projectId);
		await runtime.harness.commit(async tx => {
			const workers = await tx.doc(WorkersDoc, runtime.conversation.id);
			workers.workers.papers = { id: "papers", title: "Paper samples", conversationId: 42, workspacePath: worker, model, isolation: "workspace",
				status: "done", thinkingLevel: null, spawnedByCallId: null, anchorTaskId: 42, createdAt: at, updatedAt: at, lastReport: null, failure: null };
			workers.workers.shared = { ...workers.workers.papers, id: "shared", isolation: "shared", workspacePath: null };
			const threads = await tx.doc(ThreadsDoc, runtime.conversation.id);
			threads.threads.papers = { id: "papers", title: "Paper samples", brief: "Read some sample files", startedBy: "main", conversationId: 43, anchorTaskId: 43, scheduleId: null, startedByKey: "sample",
				model, thinkingLevel: null, onFinish: "record", status: "done", summary: null, failure: null, createdAt: at, updatedAt: at,
				finishedAt: at, archived: false, autoArchive: false, checkout: thread, checkoutKind: "directory" };
		}, BACKGROUND_CONTEXT);
		expect(await read("sample.txt", false, { kind: "worker", workerId: "papers" })).toMatchObject({ text: "Worker copy" });
		expect(await read("sample.txt", false, { kind: "thread", threadId: "papers" })).toMatchObject({ text: "Thread copy" });
		await rm(worker, { recursive: true });
		await rm(thread, { recursive: true });
		await symlink(setup.projectDir, thread);
		for (const root of [
			{ kind: "worker", workerId: "papers" }, { kind: "thread", threadId: "papers" }, { kind: "thread", threadId: "main" },
			{ kind: "thread", threadId: "missing" }, { kind: "worker", workerId: "missing" }, { kind: "worker", workerId: "shared" },
		] as const) expect(await read("sample.txt", false, root)).toMatchObject(denied("not_found"));
	});
});

test("the files switch removes the hello feature and refuses every request", async () => {
	expect(LEGACY_HARNESS_FEATURES).not.toContain("project-files");
	for (const value of ["off", " false ", "0", "NO"]) expect(projectFilesEnabled({ KEMIRI_PROJECT_FILES: value })).toBe(false);
	expect(projectFilesEnabled({})).toBe(true);
	await fixture(async ({ list, read, search }) => {
		for (const response of [await list(), await read("sample.txt"), await search("sample")]) expect(response).toMatchObject(denied("unknown_request"));
	}, { projectFiles: false });
});

test("file requests inherit required WebSocket device auth", async () => {
	await fixture(async ({ list }) => {
		expect(await list()).toMatchObject(denied("auth_required"));
	}, { auth: { mode: "required" } });
});
