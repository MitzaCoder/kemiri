import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createArtifactExtension, resolveArtifactSource } from "../src/artifact-tools.ts";
import { ARTIFACT_VERSION_LIMIT, ArtifactStore } from "../src/artifacts.ts";
import type { Project } from "../src/projects.ts";

const directories = new Set<string>();
afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "kemiri-artifact-read-test-"));
	directories.add(root);
	const store = new ArtifactStore({ dataDir: join(root, "store"), now: () => Date.UTC(2026, 0, 1) });
	const input = {
		projectId: "p", sourcePath: join(root, "report.html"), title: "Readiness", note: "Synthetic **note**.",
		threadId: "review-thread", workerId: "author", taskId: "T31",
	};
	await writeFile(input.sourcePath, "<h1>Original λ</h1>\n");
	const extension = createArtifactExtension({ store, project: () => ({ id: "p", path: root }) as Project, workspaceDirs: [], workerIdOf: async () => null });
	const tool = extension.tools!.find((tool) => tool.name === "artifact_read")!;
	const read = async (artifactId: string, version?: number) => {
		const result = await tool.execute({ artifactId, ...(version === undefined ? {} : { version }) }, {} as never, BACKGROUND_CONTEXT);
		const parsed = result as { output: { text: string }[]; isError?: boolean };
		const text = parsed.output.map((part) => part.text).join("\n");
		const path = /^Readable copy: (.+)$/m.exec(text)?.[1];
		if (path !== undefined) directories.add(dirname(path));
		return { text, path, isError: parsed.isError === true };
	};
	return { root, store, input, read, tool };
}

test("artifact_read selects latest, pinned and explicit versions and describes exactly how to revise", async () => {
	const { store, input, read } = await fixture();
	const first = await store.save(input);
	await writeFile(input.sourcePath, "<h1>Second</h1>");
	await store.save({ ...input, title: "Second title", note: "Second note" });
	await rm(input.sourcePath); // Only the stored bytes survive.
	for (const [id, version, expected] of [
		[first.id, undefined, "<h1>Second</h1>"],
		[`${first.id}~1`, undefined, "<h1>Original λ</h1>\n"],
		[first.id, 1, "<h1>Original λ</h1>\n"],
		[`${first.id}~1`, 1, "<h1>Original λ</h1>\n"],
	] as const) {
		const result = await read(id, version);
		expect(result.isError).toBe(false);
		expect(await readFile(result.path!, "utf8")).toBe(expected);
		expect(result.text).toContain("latest: 2; retained versions (2): 1, 2");
		expect(result.text).toContain("File: report.html");
		expect(result.text).toContain("Kind/MIME: text / text/html; size:");
		expect(result.text).toContain("Scope: task T31");
		expect(result.text).toContain("Saved by thread review-thread, worker author, at 2026-01-01T00:00:00.000Z");
		expect(result.text).toEndWith('Publish a revision with artifact_save using the edited file named "report.html" and taskId "T31" to create the next version of this artifact.');
	}
	const original = await read(`${first.id}~1`);
	expect(original.text).toContain(`Artifact ${first.id}~1: Readiness`);
	expect(original.text).toContain("Note: Synthetic **note**.");
	const latest = await read(first.id);
	expect(latest.text).toContain("Second title");
	expect(latest.text).toContain("Note: Second note");
});

test("copies exact binary bytes with private modes, resets edits and never exposes or modifies the store", async () => {
	const { root, store, input, read } = await fixture();
	const bytes = new Uint8Array([0, 255, 1, 128, 10, 13]);
	await writeFile(input.sourcePath, bytes);
	await chmod(input.sourcePath, 0o644);
	const saved = await store.save(input);
	const result = await read(saved.id);
	expect(result.isError).toBe(false);
	expect(result.path).not.toBe(store.filePath(saved));
	expect(result.text).not.toContain(store.filePath(saved));
	expect(await readFile(result.path!)).toEqual(Buffer.from(bytes));
	expect((await stat(result.path!)).mode & 0o777).toBe(0o600);
	expect((await stat(dirname(result.path!))).mode & 0o777).toBe(0o700);
	expect(await resolveArtifactSource({ path: result.path!, cwd: root, projectPath: root, dataDir: store.dataDir, workspaceDirs: [] })).toEqual({ ok: true, path: result.path! });
	await writeFile(result.path!, "Edited");
	expect(await readFile(store.filePath(saved))).toEqual(Buffer.from(bytes));
	const again = await read(saved.id);
	expect(again.path).toBe(result.path);
	expect(await readFile(again.path!)).toEqual(Buffer.from(bytes));
	// An edited copy may have become a symlink: replacing it must not follow that link.
	const target = join(root, "unrelated.txt");
	await writeFile(target, "Untouched");
	await rm(result.path!);
	await symlink(target, result.path!);
	expect((await read(saved.id)).isError).toBe(false);
	expect(await readFile(target, "utf8")).toBe("Untouched");
});

test("reports unknown and cross-project IDs without looking outside the calling project", async () => {
	const { store, input, read } = await fixture();
	const other = await store.save({ ...input, projectId: "other", title: "Private other title" });
	for (const id of ["unknown", other.id, `${other.id}~1`]) {
		const result = await read(id);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("No artifact");
		expect(result.text).toContain("in this project");
		expect(result.text).not.toContain("Private other title");
		expect(result.path).toBeUndefined();
	}
});

test("rejects conflicting, invalid, pruned and never-saved versions with retained numbers", async () => {
	const { store, input, read } = await fixture();
	const first = await store.save(input);
	for (let n = 1; n <= ARTIFACT_VERSION_LIMIT; n++) await store.save(input);
	for (const [id, version, message] of [
		[`${first.id}~2`, 3, "Conflicting versions"],
		[first.id, 1, "not retained (pruned or never saved)"],
		[`${first.id}~1`, undefined, "not retained (pruned or never saved)"],
		[first.id, 99, "not retained (pruned or never saved)"],
		[`${first.id}~0`, undefined, "Invalid artifact ID"],
		[`${first.id}~2~3`, undefined, "Invalid artifact ID"],
		[first.id, 1.5, "positive safe whole number"],
		[first.id, 0, "positive safe whole number"],
	] as const) {
		const result = await read(id, version);
		expect(result.isError).toBe(true);
		expect(result.text).toContain(message);
		expect(result.path).toBeUndefined();
		if (message.startsWith("not retained")) expect(result.text).toContain("Retained versions: 2, 3,");
	}
});

test("legacy metadata reads as version 1 and conversation-scoped revisions explain their boundary", async () => {
	const { root, store, input, read } = await fixture();
	const legacy = { ...input, id: "legacy", name: "report.html", kind: "text", mimeType: "text/html", size: 6, durationSeconds: null, sourcePath: input.sourcePath, createdAt: "2026-01-01T00:00:00.000Z", taskId: null };
	const directory = join(store.dir("p"), "legacy");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "report.html"), "legacy");
	await writeFile(join(store.dir("p"), "index.json"), JSON.stringify({ version: 1, artifacts: [legacy] }));
	const result = await read("legacy");
	expect(result.isError).toBe(false);
	expect(result.text).toContain("Version 1; latest: 1; retained versions (1): 1");
	expect(result.text).toContain("Scope: conversation (thread review-thread, worker author)");
	expect(result.text).toContain('file named "report.html" and omit taskId');
	expect(result.text).toContain("Only the same conversation");
	expect(result.text).toContain("saving from another conversation creates a new artifact");
	expect(result.path).not.toContain(root);
});
