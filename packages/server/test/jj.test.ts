import { afterEach, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureJjWorkspace, jjWorkspaceRevision, keepJjWorkspaceCurrent, removeJjWorkspace } from "../src/jj.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("serializes concurrent workspace creation, reuse and removal in one repository", async () => {
	const root = await mkdtemp(join(tmpdir(), "aiki-jj-test-"));
	roots.push(root);
	const repo = join(root, "repo");
	await mkdir(repo);
	await writeFile(join(repo, "README.md"), "# test repository\n");
	const child = Bun.spawn(["jj", "git", "init"], { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ code, stdout, stderr }).toMatchObject({ code: 0 });

	const workspaces = Array.from({ length: 4 }, (_, index) => ({
		repo,
		name: `worker-${index}`,
		path: join(root, `worker-${index}`),
	}));
	// Distinct workers share jj's Git ref export. Repeated calls for the same
	// worker must also be idempotent, even before the first creation finishes.
	await Promise.all(workspaces.flatMap((workspace) => [ensureJjWorkspace(workspace), ensureJjWorkspace(workspace)]));
	for (const workspace of workspaces) {
		expect(await readdir(workspace.path)).toContain("README.md");
	}

	// A failed operation must not strand later creations or cleanups in the queue.
	const retry = { repo, name: "retry", path: join(root, "retry") };
	const failed = ensureJjWorkspace({ ...retry, revision: "missing-revision" });
	const recovered = ensureJjWorkspace(retry);
	await expect(failed).rejects.toThrow("missing-revision");
	await recovered;
	await Promise.all([...workspaces, retry].flatMap((workspace) => [removeJjWorkspace(workspace), removeJjWorkspace(workspace)]));
	expect(await readdir(root)).toEqual(["repo"]);
}, 60_000);

async function jj(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(["jj", "--config", "user.name=Test", "--config", "user.email=test@example.com", ...args], {
		cwd, stdout: "pipe", stderr: "pipe", timeout: 60_000,
	});
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { code, stdout, stderr };
}

async function staleWorkspace() {
	const root = await mkdtemp(join(tmpdir(), "kemiri-stale-test-"));
	roots.push(root);
	const repo = join(root, "repo");
	const path = join(root, "worker");
	await mkdir(repo);
	expect((await jj(repo, "git", "init")).code).toBe(0);
	await writeFile(join(repo, "base.txt"), "original\n");
	await writeFile(join(repo, "deleted.txt"), "delete me\n");
	expect((await jj(repo, "commit", "-m", "base")).code).toBe(0);
	const revision = (await jj(repo, "log", "--no-graph", "-r", "@", "-T", "commit_id")).stdout;
	await ensureJjWorkspace({ repo, path, name: "worker" });
	expect(await jjWorkspaceRevision(path)).toBe(revision);
	const change = (await jj(path, "log", "--no-graph", "-r", "@", "-T", "change_id")).stdout;
	const rewrite = async () => {
		await writeFile(join(repo, "base.txt"), "rewritten\n");
		expect((await jj(repo, "describe", "-m", "rewrite parent")).code).toBe(0);
		expect((await jj(path, "status")).stderr).toContain("working copy is stale");
	};
	return { root, repo, path, change, rewrite };
}

it("leaves a current workspace alone, then updates a stale workspace without edits", async () => {
	const ws = await staleWorkspace();
	let attempts = 0;
	const options = { ...ws, beforeUpdate: async () => { attempts++; } };
	expect(await keepJjWorkspaceCurrent(options)).toBeUndefined();
	expect(attempts).toBe(0);
	await ws.rewrite();
	expect(await keepJjWorkspaceCurrent(options)).toBe("The harness ran `jj workspace update-stale` for your stale workspace.");
	expect(attempts).toBe(1);
	expect(await readFile(join(ws.path, "base.txt"), "utf8")).toBe("rewritten\n");
	expect((await jj(ws.path, "status")).code).toBe(0);
	expect(await keepJjWorkspaceCurrent(options)).toBeUndefined();
	expect(attempts).toBe(1);
});

it("names the divergent snapshot holding unsnapshotted edits instead of silently losing them from the checkout", async () => {
	const ws = await staleWorkspace();
	await writeFile(join(ws.path, "base.txt"), "worker edit\n");
	await writeFile(join(ws.path, "binary.bin"), new Uint8Array([0, 255, 12, 0]));
	await writeFile(join(ws.path, "executable.sh"), "#!/bin/sh\nexit 0\n");
	await chmod(join(ws.path, "executable.sh"), 0o755);
	await rm(join(ws.path, "deleted.txt"));
	await ws.rewrite();
	const note = await keepJjWorkspaceCurrent(ws);
	expect(note).toContain("NOT in the working copy");
	const versions = (await jj(ws.path, "log", "--ignore-working-copy", "--no-graph", "-r", `change_id(${ws.change}) ~ @`, "-T", 'commit_id ++ "\\n"')).stdout.trim().split("\n");
	expect(versions.length).toBeGreaterThan(0);
	for (const id of versions) expect(note).toContain(id);
	const recovery = versions[0]!;
	expect((await jj(ws.path, "file", "show", "-r", recovery, "base.txt")).stdout).toContain("worker edit");
	expect((await jj(ws.path, "file", "list", "-r", recovery)).stdout).not.toContain("deleted.txt");
	const binary = Bun.spawn(["jj", "file", "show", "-r", recovery, "binary.bin"], { cwd: ws.path, stdout: "pipe", stderr: "pipe" });
	expect(new Uint8Array(await new Response(binary.stdout).arrayBuffer())).toEqual(new Uint8Array([0, 255, 12, 0]));
	expect(await binary.exited).toBe(0);
	expect((await jj(ws.path, "diff", "--from", `${recovery}-`, "--to", recovery, "--git", "executable.sh")).stdout).toContain("100755");
	// This is the actual jj 0.47.1 trap: successful update, but the edit is in the reported version, not @.
	expect(await readFile(join(ws.path, "base.txt"), "utf8")).toBe("rewritten\n");
	expect((await jj(ws.path, "status")).code).toBe(0);
});

it("finds the edit snapshot even when abandoning the worker changed its working-copy change ID", async () => {
	const ws = await staleWorkspace();
	await writeFile(join(ws.path, "precious.txt"), "keep this\n");
	await ws.rewrite();
	expect((await jj(ws.repo, "abandon", "worker@")).code).toBe(0);
	const note = await keepJjWorkspaceCurrent(ws);
	const recovery = (await jj(ws.path, "log", "--ignore-working-copy", "--no-graph", "-r", `change_id(${ws.change})`, "-T", "commit_id")).stdout;
	expect(recovery).toMatch(/^[0-9a-f]{40,64}$/);
	expect(note).toContain(recovery);
	expect((await jj(ws.path, "file", "show", "-r", recovery, "precious.txt")).stdout).toBe("keep this\n");
});

it("does not attempt recovery for unrelated jj errors", async () => {
	const root = await mkdtemp(join(tmpdir(), "kemiri-not-jj-"));
	roots.push(root);
	let attempts = 0;
	await expect(keepJjWorkspaceCurrent({ repo: root, path: root, beforeUpdate: async () => { attempts++; } })).rejects.toThrow();
	expect(attempts).toBe(0);
});

it("preserves and reports jj warnings when a large unsnapshotted file collides with the fresh tree", async () => {
	const ws = await staleWorkspace();
	await jj(ws.repo, "config", "set", "--repo", "snapshot.max-new-file-size", "1048576");
	const bytes = new Uint8Array(2 * 1024 * 1024).fill(255);
	await writeFile(join(ws.path, "large.bin"), bytes);
	await writeFile(join(ws.repo, "large.bin"), "colliding new file\n");
	await ws.rewrite();
	const note = await keepJjWorkspaceCurrent(ws);
	expect(note).toContain("Warning:");
	expect(note).toContain("Refused to snapshot");
	expect(note).toContain("updates were skipped");
	expect(new Uint8Array(await readFile(join(ws.path, "large.bin")))).toEqual(bytes);
});

it("makes only one update attempt on failure and leaves edits available", async () => {
	const ws = await staleWorkspace();
	await writeFile(join(ws.path, "precious.txt"), "keep this\n");
	await ws.rewrite();
	let attempts = 0;
	await expect(keepJjWorkspaceCurrent({ ...ws, beforeUpdate: async () => {
		attempts++;
		// Forgetting this workspace after the probe makes update-stale fail (real jj, no executable mock).
		expect((await jj(ws.repo, "workspace", "forget", "worker")).code).toBe(0);
	} })).rejects.toThrow("attempted once");
	expect(attempts).toBe(1);
	expect(await readFile(join(ws.path, "precious.txt"), "utf8")).toBe("keep this\n");
});
