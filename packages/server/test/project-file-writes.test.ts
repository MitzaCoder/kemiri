import { HARNESS_FEATURES, LEGACY_HARNESS_FEATURES, MAX_FILE_BYTES } from "@kemiri/protocol";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProjectFileWrites } from "../src/project-file-writes.ts";
import { createSetup, TestClient } from "./support.ts";

const oldText = "Paper sample\n";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const baseHash = sha256(oldText);
const error = (code: string) => ({ type: "error", error: { code } });

async function fixture(work: (fixture: {
	setup: Awaited<ReturnType<typeof createSetup>>; root: string; projectId: string; client: TestClient;
	configure(value: boolean | null): ReturnType<TestClient["request"]>;
	save(path?: string, text?: string, hash?: string): ReturnType<TestClient["request"]>;
}) => Promise<void>, options?: Parameters<typeof createSetup>[0]) {
	const setup = await createSetup(options);
	const root = setup.projectDir;
	const client = await TestClient.open(setup.server);
	try {
		const { id: projectId } = await setup.server.manager.store.add(root);
		await writeFile(join(root, "sample.txt"), oldText);
		if (options?.auth?.mode !== "required") {
			const hello = await client.hello();
			expect(hello.type === "hello" && hello.features?.includes("project-files-write")).toBe(options?.projectFiles !== false && (!options?.features || options.features.includes("project-files-write")));
		}
		await work({ setup, root, projectId, client,
			configure: allowFileWrites => client.request({ type: "projects.configure", projectId, allowFileWrites }),
			save: (path = "sample.txt", text = "New paper sample\n", hash = baseHash) => client.request({ type: "files.write", projectId, path, text, baseHash: hash }),
		});
	} finally { client.close(); await setup.cleanup(); }
}

test("direct saves are off by default and their explicit project setting persists and resets", async () => {
	await fixture(async ({ setup, root, projectId, client, configure, save }) => {
		const before = await client.request({ type: "projects.list" });
		expect(before).toMatchObject({ projects: [{ id: projectId, allowFileWrites: false }] });
		expect(await save()).toMatchObject({ type: "error", error: { code: "permission_denied", message: expect.stringContaining("Allow saving files from the app is off") } });
		expect(await configure(true)).toMatchObject({ project: { allowFileWrites: true } });
		expect(await client.request({ type: "projects.configure", projectId, name: "Paper samples" })).toMatchObject({ project: { allowFileWrites: true } });
		const other = join(setup.root, "another-project");
		await mkdir(other);
		const { id: otherId } = await setup.server.manager.store.add(other);
		await writeFile(join(other, "sample.txt"), oldText);
		expect(await client.request({ type: "files.write", projectId: otherId, path: "sample.txt", text: "Different project", baseHash })).toMatchObject(error("permission_denied"));
		client.close();
		const again = await TestClient.open(await setup.restart());
		try {
			await again.hello();
			expect(await again.request({ type: "projects.list" })).toMatchObject({ projects: expect.arrayContaining([{ id: projectId, allowFileWrites: true }].map(item => expect.objectContaining(item))) });
			expect(await again.request({ type: "projects.configure", projectId, allowFileWrites: false })).toMatchObject({ project: { allowFileWrites: false } });
			expect(await again.request({ type: "projects.configure", projectId, allowFileWrites: true })).toMatchObject({ project: { allowFileWrites: true } });
			expect(await again.request({ type: "projects.configure", projectId, allowFileWrites: null })).toMatchObject({ project: { allowFileWrites: false } });
			expect(await again.request({ type: "files.write", projectId, path: "sample.txt", text: "Disabled", baseHash })).toMatchObject(error("permission_denied"));
		} finally { again.close(); }
		expect(await readFile(join(root, "sample.txt"), "utf8")).toBe(oldText);
	});
});

test("save reports a stale hash conflict, and atomic replacement keeps the mode and submitted line endings", async () => {
	await fixture(async ({ root, save, configure, client, projectId }) => {
		await configure(true);
		const path = join(root, "sample.txt");
		await chmod(path, 0o751);
		const disk = "Disk version\r\n";
		await writeFile(path, disk);
		const actualHash = sha256(disk);
		expect(await save()).toMatchObject({ type: "files.write", status: "conflict", current: { text: disk, hash: actualHash } });
		expect(await readFile(path, "utf8")).toBe(disk);
		const existing = await open(path, "r");
		try {
			const submitted = "New paper\r\nNew cover\r\n";
			const savedHash = sha256(submitted);
			const reply = await save("sample.txt", submitted, actualHash);
			const info = await stat(path);
			expect(reply).toMatchObject({ type: "files.write", status: "saved", hash: savedHash, size: Buffer.byteLength(submitted), modifiedAt: info.mtime.toISOString() });
			expect(info.mode & 0o7777).toBe(0o751);
			expect(await existing.readFile("utf8")).toBe(disk);
			expect(await readFile(path, "utf8")).toBe(submitted);
			expect(await client.request({ type: "files.read", projectId, root: { kind: "project" }, path: "sample.txt" })).toMatchObject({ hash: savedHash, text: submitted });
			expect((await readdir(root)).filter(name => name.startsWith(".kemiri-save-"))).toEqual([]);
		} finally { await existing.close(); }
	});
});

test("a simulated replacement failure leaves the entire original and cleans up the completed scratch file", async () => {
	await fixture(async ({ root, projectId, client }) => {
		const next = "New paper\n".repeat(25_000);
		let replacements = 0;
		const writer = new ProjectFileWrites(async (temp, target) => {
			replacements++;
			expect(dirname(String(temp))).toBe(dirname(String(target)));
			expect(await readFile(temp, "utf8")).toBe(next);
			expect(await readFile(target, "utf8")).toBe(oldText);
			const tempName = String(temp).split("/").at(-1)!;
			const list = await client.request({ type: "files.list", projectId, root: { kind: "project" }, path: "", showHidden: true });
			expect(list.type === "files.list" && list.entries.some(({ name }) => name === tempName)).toBe(false);
			expect(await client.request({ type: "files.read", projectId, root: { kind: "project" }, path: tempName })).toMatchObject(error("invalid_path"));
			throw Object.assign(new Error("Simulated replacement failure"), { code: "ENOSPC" });
		});
		await expect(writer.write(root, "sample.txt", next, baseHash, async () => {})).rejects.toThrow("Could not save the file");
		expect(replacements).toBe(1);
		expect(await readFile(join(root, "sample.txt"), "utf8")).toBe(oldText);
		expect((await readdir(root)).filter(name => name.startsWith(".kemiri-save-"))).toEqual([]);
	});
});

test("save rechecks a local edit or removal after staging and never overwrites that edit or recreates the file", async () => {
	await fixture(async ({ root }) => {
		const path = join(root, "sample.txt");
		let checks = 0;
		const writer = new ProjectFileWrites(rename);
		const edited = "Local edit\n";
		const result = await writer.write(root, "sample.txt", "App edit\n", baseHash, async () => {
			if (++checks === 2) await writeFile(path, edited);
		});
		expect(result.status).toBe("conflict");
		expect(await readFile(path, "utf8")).toBe(edited);
		checks = 0;
		await expect(writer.write(root, "sample.txt", "App edit\n", sha256(edited), async () => {
			if (++checks === 2) await rm(path);
		})).rejects.toThrow("Only existing files can be saved");
		expect(await stat(path).catch(() => undefined)).toBeUndefined();
		expect((await readdir(root)).filter(name => name.startsWith(".kemiri-save-"))).toEqual([]);
	});
});

test("writes refuse outside paths, symlinks, unsupported roots, missing or protected files, and non-text payloads", async () => {
	await fixture(async ({ setup, root, client, projectId, configure, save }) => {
		await configure(true);
		const outside = join(setup.root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "sample.txt"), oldText);
		await mkdir(join(root, "inside"));
		await writeFile(join(root, "inside", "sample.txt"), oldText);
		await symlink(outside, join(root, "escape-dir"));
		await symlink("inside", join(root, "inside-dir"));
		await symlink(join(outside, "sample.txt"), join(root, "escape.txt"));
		await symlink("sample.txt", join(root, "inside.txt"));
		await symlink("not-found.txt", join(root, "dangling.txt"));
		for (const dir of [".git", ".jj"]) await mkdir(join(root, dir));
		for (const path of [".git/config", ".jj/config", ".env.sample", "sample.pem", "id_sample", ".npmrc", ".netrc", "sample-credentials.json"]) await writeFile(join(root, path), oldText);
		await writeFile(join(root, "binary.bin"), Uint8Array.of(0, 1));
		await writeFile(join(root, "invalid.txt"), Uint8Array.of(0xff));
		await writeFile(join(root, "large.txt"), "p".repeat(MAX_FILE_BYTES + 1));
		for (const path of ["../outside/sample.txt", join(outside, "sample.txt"), "escape-dir/sample.txt", "inside-dir/sample.txt", "escape.txt", "inside.txt", ".git/config", ".jj/config", "a\\b", "a\0b", "é".repeat(2200)]) {
			expect(await save(path)).toMatchObject(error("invalid_path"));
		}
		for (const path of ["missing.txt", "dangling.txt"]) expect(await save(path)).toMatchObject(error("not_found"));
		for (const path of ["inside", "binary.bin", "invalid.txt", "large.txt"]) expect(await save(path)).toMatchObject(error("bad_request"));
		for (const path of [".env.sample", "sample.pem", "id_sample", ".npmrc", ".netrc", "sample-credentials.json"]) expect(await save(path)).toMatchObject(error("permission_denied"));
		for (const text of ["é".repeat(MAX_FILE_BYTES / 2 + 1), "invalid\ud800", "paper\0sample"]) expect(await save("sample.txt", text)).toMatchObject(error("bad_request"));
		for (const root of [{ kind: "worker", workerId: "example" }, { kind: "thread", threadId: "example" }]) {
			expect(await client.request({ type: "files.write", projectId, root, path: "sample.txt", text: "not saved", baseHash })).toMatchObject(error("bad_request"));
		}
		expect(await readFile(join(root, "sample.txt"), "utf8")).toBe(oldText);
		expect(await readFile(join(outside, "sample.txt"), "utf8")).toBe(oldText);
	});
});

test("writes with the same base hash from two WebSockets produce one save and one conflict", async () => {
	await fixture(async ({ setup, root, projectId, configure, save }) => {
		await configure(true);
		const other = await TestClient.open(setup.server);
		try {
			await other.hello();
			const [a, b] = await Promise.all([save("sample.txt", "First edit\n"), other.request({ type: "files.write", projectId, path: "sample.txt", text: "Second edit\n", baseHash })]);
			if (a.type !== "files.write" || b.type !== "files.write") throw new Error("Expected typed file write responses");
			expect([a.status, b.status].sort()).toEqual(["conflict", "saved"]);
			const disk = await readFile(join(root, "sample.txt"), "utf8");
			const winner = a.status === "saved" ? a : b;
			const loser = a.status === "conflict" ? a : b;
			expect(winner).toMatchObject({ hash: sha256(disk) });
			expect(loser).toMatchObject({ current: { text: disk, hash: sha256(disk) } });
		} finally { other.close(); }
	});
});

for (const options of [{ projectFiles: false }, { features: HARNESS_FEATURES.filter(feature => feature !== "project-files-write") }]) test(`the backend refuses writes with ${Object.keys(options)[0]} disabled`, async () => {
	expect(LEGACY_HARNESS_FEATURES).not.toContain("project-files-write");
	await fixture(async ({ configure, save }) => {
		await configure(true);
		expect(await save()).toMatchObject(error("unknown_request"));
	}, options);
});

test("file saves inherit required WebSocket device authentication", async () => {
	await fixture(async ({ setup, projectId, save }) => {
		await setup.server.manager.store.update(projectId, { allowFileWrites: true });
		expect(await save()).toMatchObject(error("auth_required"));
	}, { auth: { mode: "required" } });
});
