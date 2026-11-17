import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ARTIFACT_MAX_TAGS, type Artifact } from "@kemiri/protocol";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactTagsFromFileName } from "../src/artifact-file-tags.ts";
import { createArtifactExtension } from "../src/artifact-tools.ts";
import { ArtifactStore } from "../src/artifacts.ts";
import type { Project } from "../src/projects.ts";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test("file-name tags use only the final suffix and final extension, ignoring invalid words", () => {
	for (const [name, tags] of [
		["task-board.png", []],
		["task-board--web-phone-dark-after.png", ["web", "phone", "dark", "after"]],
		["task--ignored--WEB-Phone2.PNG", ["web", "phone2"]],
		["task--web-bad_tag-bad+tag-ümlaut-after!.png", ["web"]],
		["task--web--dark.png", ["dark"]],
		["task---web-.png", ["web"]],
		["task--.png", []],
		["task--WEB-phone", ["web", "phone"]],
		["task--web.tar.gz", []],
		[`task--${"a".repeat(24)}-${"b".repeat(25)}.png`, ["a".repeat(24)]],
		["folder--web/task.png", []],
	] as const) expect(artifactTagsFromFileName(name)).toEqual([...tags]);
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "kemiri-artifact-save-test-"));
	directories.push(root);
	const store = new ArtifactStore({ dataDir: join(root, "store"), maxFileBytes: 128 });
	const extension = createArtifactExtension({ store, project: () => ({ id: "p", path: root }) as Project,
		workspaceDirs: [], workerIdOf: async () => "worker", threadIdOf: async () => "thread" });
	const tool = extension.tools!.find((tool) => tool.name === "artifact_save")!;
	type Args = { path?: string; paths?: string[]; title?: string; note?: string; taskId?: string; tags?: string[] };
	const receipt = () => new Map<string, string>();
	const save = async (args: Args, memo = receipt()) => {
		const api = { conversationId: 1, now: () => 1, agent: async () => ({ cwd: root }),
			memo: async (key: string, id: string) => {
				if (!memo.has(key)) memo.set(key, id);
				return memo.get(key)!;
			} };
		const result = await tool.execute(args, api as never, BACKGROUND_CONTEXT) as {
			output: { text: string }[]; isError?: boolean;
			details?: { artifactId?: string; files?: ({ path: string; artifactId?: string; version?: number; error?: string })[] };
		};
		return { ...result, text: result.output.map((part) => part.text).join("\n") };
	};
	const list = () => store.list("p");
	return { root, store, save, list, receipt };
}

test("saves every file, shared metadata and merged tags, with per-file IDs and versions", async () => {
	const { root, save, list } = await fixture();
	await writeFile(join(root, "board--web-phone-dark-after.txt"), "board");
	await writeFile(join(root, "report--web-desktop.txt"), "report");
	const result = await save({ paths: ["board--web-phone-dark-after.txt", "report--web-desktop.txt"],
		title: "Ignored for several files", taskId: "T1", note: "Shared note", tags: [" WEB ", "custom", "web"] });
	expect(result.isError).toBeUndefined();
	expect(result.details?.files).toHaveLength(2);
	expect(result.details?.artifactId).toBe(result.details?.files?.[0]?.artifactId);
	const saved = await list();
	expect(saved).toHaveLength(2);
	for (const artifact of saved) {
		expect(artifact).toMatchObject({ title: null, taskId: "T1", note: "Shared note", threadId: "thread", workerId: "worker" });
		expect(result.text).toContain(`${artifact.id}~1`);
	}
	expect(saved.find((a: Artifact) => a.name.startsWith("board"))?.tags).toEqual(["web", "custom", "phone", "dark", "after"]);
	expect(saved.find((a: Artifact) => a.name.startsWith("report"))?.tags).toEqual(["web", "custom", "desktop"]);
});

test("reports missing, forbidden, directory and copy failures without skipping later files", async () => {
	const { root, save, list } = await fixture();
	await writeFile(join(root, "first.txt"), "first");
	await writeFile(join(root, "last.txt"), "last");
	await writeFile(join(root, "large.txt"), "x".repeat(129));
	await mkdir(join(root, "frames"));
	await mkdir(join(root, "store"));
	await writeFile(join(root, "store", "secret.txt"), "not allowed");
	await symlink(join(root, "store", "secret.txt"), join(root, "link.txt"));
	const result = await save({ paths: ["first.txt", "missing.txt", "link.txt", "frames", "large.txt", "last.txt"] });
	expect(result.isError).toBe(true);
	expect(result.details?.files?.filter((file) => file.artifactId)).toHaveLength(2);
	expect(result.details?.files?.filter((file) => file.error)).toHaveLength(4);
	expect(result.text).toContain('"missing.txt": Saving the artifact failed:');
	expect(result.text).toContain("does not exist");
	expect(result.text).toContain("outside the paths");
	expect(result.text).toContain("is a directory");
	expect(result.text).toContain('"last.txt": Saved artifact');
	expect(await list()).toHaveLength(2);
});

test("requires exactly one source field and bounds batches before saving anything", async () => {
	const { save, list } = await fixture();
	for (const args of [{}, { path: "a", paths: ["b"] }]) {
		expect((await save(args)).text).toBe("Give exactly one of path or paths (1–50 files).");
	}
	for (const paths of [[], Array.from({ length: 51 }, () => "a")]) {
		const result = await save({ paths });
		expect(result.isError).toBe(true);
		expect(result.text).toBe("paths must contain 1–50 files.");
	}
	expect(await list()).toHaveLength(0);
});

test("replay reuses each ID, including after partial completion, and fresh calls version each file", async () => {
	const { root, save, list, receipt } = await fixture();
	await writeFile(join(root, "first.txt"), "first");
	const args = { paths: ["first.txt", "later.txt"], taskId: "T1" };
	const memo = receipt();
	const partial = await save(args, memo);
	expect(partial.isError).toBe(true);
	const firstId = partial.details?.files?.[0]?.artifactId;
	await writeFile(join(root, "later.txt"), "later");
	const completed = await save(args, memo);
	expect(completed.details?.files?.[0]?.artifactId).toBe(firstId);
	expect((await save(args, memo)).details).toEqual(completed.details);
	expect(memo.size).toBe(2);
	expect((await list()).map((a: Artifact) => a.version)).toEqual([1, 1]);
	const next = await save(args);
	expect(next.details?.files?.map((file) => file.artifactId)).toEqual(completed.details?.files?.map((file) => file.artifactId));
	expect(next.details?.files?.map((file) => file.version)).toEqual([2, 2]);
	const otherTask = await save({ ...args, taskId: "T2" });
	expect(otherTask.details?.files?.[0]?.artifactId).not.toBe(firstId);
	expect(await list()).toHaveLength(4);
});

test("single file retains legacy receipt/details, allows title with paths and applies store tag limits", async () => {
	const { root, save, receipt, list } = await fixture();
	await writeFile(join(root, "single--phone.txt"), "one");
	const memo = receipt();
	const missing = await save({ path: "missing.txt" });
	expect(missing.isError).toBe(true);
	expect(missing.details).toBeUndefined();
	const args = { path: "single--phone.txt", title: "Single", tags: Array.from({ length: 20 }, (_, i) => `tag${i}`) };
	const first = await save(args, memo);
	expect(first.details?.artifactId).toBeDefined();
	expect((await save(args, memo)).details).toEqual(first.details);
	expect([...memo.keys()]).toEqual(["artifactId"]);
	expect((await list())[0]?.tags).toHaveLength(ARTIFACT_MAX_TAGS);
	await save({ paths: ["single--phone.txt"], title: "Still single" });
	expect((await list())[0]?.title).toBe("Still single");
	expect((await list())[0]?.tags).toEqual(["phone"]);
});
