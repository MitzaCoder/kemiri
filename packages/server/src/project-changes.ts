import {
	MAX_CHANGE_FILES, MAX_CHANGE_PATCH_BYTES, MAX_CHANGE_PATH_BYTES, MAX_CHANGE_SIDE_BYTES,
	type ChangeCommit, type ChangedFile, type ChangeFileSide, type ChangeSource,
	type ChangesFileResponse, type ChangesListResponse,
} from "@kemiri/protocol";
import { ServerError } from "./errors.ts";
import { gitIntegrationTip, gitRepository, runVcsCommand, VcsCommandError } from "./task-changes.ts";

type Commit = Omit<ChangeCommit, "landed"> & { firstParent?: string };
type CommitRange = { base?: string; tip: string };
type BlobSide = { mode: string; hash: string };
type FileDelta = { file: ChangedFile; before?: BlobSide; after?: BlobSide };
type ListPayload = Omit<ChangesListResponse, "type" | "id">;
type FilePayload = Omit<ChangesFileResponse, "type" | "id">;

const gitHash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const emptyTree = {
	sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
	sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};
const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=none"];

function validPath(path: string): boolean {
	return Buffer.byteLength(path) <= MAX_CHANGE_PATH_BYTES && !/[\\\0]/.test(path) && !/^[a-z]:/i.test(path) &&
		path.split("/").every(segment => segment && !/^(?:\.{1,2}|\.(?:git|jj)[. ]*)$/i.test(segment)) &&
		Buffer.from(path).toString("utf8") === path;
}

function decodePath(bytes: Buffer): string | undefined {
	try {
		const path = utf8.decode(bytes);
		return validPath(path) ? path : undefined;
	} catch { return undefined; }
}

function isRegular({ mode }: BlobSide): boolean { return mode === "100644" || mode === "100755"; }

/** `--raw --numstat -z` gives modes and blob IDs first, then statistics in the same file order. */
function parseDiff(output: Buffer): FileDelta[] {
	let offset = 0;
	const field = () => {
		const end = output.indexOf(0, offset);
		if (end === -1) throw new Error("Incomplete Git diff record");
		const bytes = output.subarray(offset, end);
		offset = end + 1;
		return bytes;
	};
	const raw: { path?: string | undefined; previousPath?: string | undefined; rename: boolean; status: ChangedFile["status"]; before?: BlobSide; after?: BlobSide }[] = [];
	while (output[offset] === 0x3a) {
		const [oldMode, newMode, oldHash, newHash, statusCode] = field().toString("ascii").slice(1).split(" ");
		if (!oldMode || !newMode || !oldHash || !newHash || !gitHash.test(oldHash) || !gitHash.test(newHash)) throw new Error("Invalid Git diff record");
		const rename = statusCode?.startsWith("R") === true;
		const firstPath = decodePath(field());
		raw.push({
			path: rename ? decodePath(field()) : firstPath, previousPath: rename ? firstPath : undefined, rename,
			status: rename ? "renamed" : statusCode === "A" ? "added" : statusCode === "D" ? "deleted" : "modified",
			...(oldMode === "000000" ? {} : { before: { mode: oldMode, hash: oldHash } }),
			...(newMode === "000000" ? {} : { after: { mode: newMode, hash: newHash } }),
		});
	}
	const files: FileDelta[] = [];
	for (const { path, previousPath, rename, status, before, after } of raw) {
		const counts = field();
		const firstTab = counts.indexOf(9);
		const secondTab = counts.indexOf(9, firstTab + 1);
		if (firstTab < 0 || secondTab < 0 || rename !== (counts.length === secondTab + 1)) throw new Error("Invalid Git numstat record");
		if (rename) { field(); field(); } // rename's two paths are separate NUL-terminated fields
		if (!path || (rename && !previousPath)) continue;
		const additions = counts.toString("ascii", 0, firstTab);
		const deletions = counts.toString("ascii", firstTab + 1, secondTab);
		const binary = additions === "-" || deletions === "-" || (!!before && !isRegular(before)) || (!!after && !isRegular(after));
		files.push({
			file: { path, ...(previousPath === undefined ? {} : { previousPath }), status, binary,
				additions: binary ? 0 : Number(additions), deletions: binary ? 0 : Number(deletions) },
			...(before ? { before } : {}), ...(after ? { after } : {}),
		});
	}
	if (offset !== output.length) throw new Error("Unexpected Git diff records");
	return files;
}

/** A combined task diff is safe only when every attributed hash is in one first-parent chain. */
function firstParentChain(commits: Commit[]): Commit[] | undefined {
	const byHash = new Map(commits.map(commit => [commit.hash, commit]));
	const parents = new Set(commits.map(commit => commit.firstParent));
	const tips = commits.filter(commit => !parents.has(commit.hash));
	if (tips.length !== 1) return undefined;
	const chain: Commit[] = [];
	for (let commit: Commit | undefined = tips[0]; commit; commit = commit.firstParent ? byHash.get(commit.firstParent) : undefined) chain.push(commit);
	return chain.length === commits.length ? chain.reverse() : undefined;
}

async function readChanges<T>(read: () => Promise<T>): Promise<T> {
	try { return await read(); }
	catch (error) {
		if (!(error instanceof VcsCommandError)) throw error;
		throw new ServerError("harness_failed", error.reason === "timeout" ? "Git change read timed out" :
			error.reason === "output_limit" ? "Git change read exceeded its output limit" : "Git could not read this change");
	}
}

export class ProjectChanges {
	constructor(readonly projectPath: string, readonly integrationRef: string | null | undefined,
		readonly attributedCommits: (gitStore: string, taskId: string) => Promise<ReadonlyMap<string, string[]>>) {}

	async list(source: ChangeSource): Promise<ListPayload> { return readChanges(async () => {
		const repository = await this.#repository();
		const { commits, range, nonContiguousReason } = await this.#selection(repository, source);
		const integration = commits.length ? await gitIntegrationTip(args => repository.text(args), this.integrationRef) : undefined;
		const described: ChangeCommit[] = [];
		for (let offset = 0; offset < commits.length; offset += 8) {
			described.push(...await Promise.all(commits.slice(offset, offset + 8).map(async ({ firstParent: _, ...commit }) => ({
				...commit, landed: integration ? await repository.isAncestor(commit.hash, integration.tip) : false,
			}))));
		}
		const files = range ? await repository.files(range) : [];
		return {
			commits: described, files: files.slice(0, MAX_CHANGE_FILES).map(delta => delta.file), truncated: files.length > MAX_CHANGE_FILES,
			...(source.kind === "task" ? { contiguous: !!range, ...(nonContiguousReason ? { nonContiguousReason } : {}) } : {}),
		};
	}); }

	async file(source: ChangeSource, path: string): Promise<FilePayload> { return readChanges(async () => {
		if (!validPath(path)) throw new ServerError("invalid_path", "Expected a relative repository file path");
		const repository = await this.#repository();
		const { range, nonContiguousReason } = await this.#selection(repository, source);
		if (!range) throw new ServerError("bad_request", nonContiguousReason === "no-commits" ? "This task has no commits" :
			"Task commits are not one first-parent range; choose an individual commit");
		const delta = (await repository.files(range)).find(delta => delta.file.path === path);
		if (!delta) throw new ServerError("not_found", "No changed file at that path");
		if (delta.file.binary) return { binary: true };
		return repository.file(range, delta);
	}); }

	async #repository(): Promise<GitChanges> {
		const gitStore = await gitRepository(this.projectPath, true);
		if (!gitStore) throw new ServerError("not_found", "This project has no Git store");
		return new GitChanges(gitStore);
	}

	async #selection(repository: GitChanges, source: ChangeSource): Promise<{
		commits: Commit[]; range?: CommitRange; nonContiguousReason?: ListPayload["nonContiguousReason"];
	}> {
		const attribution = source.kind === "commit" ? new Map([[source.hash.toLowerCase(), [] as string[]]]) : await this.attributedCommits(repository.gitStore, source.taskId);
		const hashes = [...attribution.keys()];
		if (!hashes.length) return { commits: [], nonContiguousReason: "no-commits" };
		const commits: Commit[] = [];
		for (let offset = 0; offset < hashes.length; offset += 8) {
			commits.push(...await Promise.all(hashes.slice(offset, offset + 8).map(async hash => {
				const commit = await repository.commit(hash);
				const partIds = attribution.get(hash)!;
				return partIds.length ? { ...commit, partIds } : commit;
			})));
		}
		const chain = firstParentChain(commits);
		if (!chain) return { commits, nonContiguousReason: "not-first-parent-chain" };
		const base = chain[0]?.firstParent;
		return { commits: chain, range: { ...(base ? { base } : {}), tip: chain.at(-1)!.hash } };
	}
}

class GitChanges {
	constructor(readonly gitStore: string) {}

	#read(args: string[], maxBuffer?: number, keepOutputPrefix = false) {
		// No index or checkout is used, even for attributes. Do not let configuration turn on tracing or helpers.
		return runVcsCommand("git", [`--git-dir=${this.gitStore}`, "-c", "core.bare=true", "-c", "core.attributesFile=/dev/null", ...args],
			this.gitStore, maxBuffer, keepOutputPrefix);
	}

	async text(args: string[]): Promise<string> { return (await this.#read(args)).stdout.toString("utf8").trimEnd(); }

	async commit(hash: string): Promise<Commit> {
		if (!gitHash.test(hash)) throw new ServerError("bad_request", "Expected a full Git commit hash");
		let output: string;
		try {
			// `^{commit}` checks the type; exact equality rejects ref-name fallback, abbreviations and annotated tags.
			output = await this.text(["rev-parse", "--verify", "--quiet", `${hash}^{commit}`]);
		} catch (error) {
			if (!(error instanceof VcsCommandError && error.exitCode === 1)) throw error;
			output = "";
		}
		if (output !== hash) throw new ServerError("not_found", "No commit with that full hash in this project");
		// Read the object's parent header: a shallow boundary must not be presented as a root commit.
		const { stdout } = await this.#read(["cat-file", "commit", hash]);
		const header = stdout.toString("utf8", 0, stdout.indexOf("\n\n"));
		const firstParent = /^parent ([0-9a-f]+)$/m.exec(header)?.[1];
		const { stdout: formatted } = await this.#read(["show", "-s", "--no-notes", "--no-show-signature", "--encoding=UTF-8",
			"--format=%s%x00%an%x00%aI", hash, "--"]);
		const [subject = "", author = "", time = ""] = formatted.toString("utf8").trimEnd().split("\0");
		return { hash, subject, author, time, ...(firstParent ? { firstParent } : {}) };
	}

	async isAncestor(hash: string, tip: string): Promise<boolean> {
		try { await this.#read(["merge-base", "--is-ancestor", hash, tip]); return true; }
		catch (error) { if (error instanceof VcsCommandError && error.exitCode === 1) return false; throw error; }
	}

	async files({ base, tip }: CommitRange): Promise<FileDelta[]> {
		const { stdout } = await this.#read(["diff-tree", "--no-commit-id", "-r", "-M", "-l1000", "--raw", "--no-abbrev", "--numstat", "-z",
			...diffOptions, base ?? this.#emptyTree(tip), tip, "--"]);
		return parseDiff(stdout);
	}

	#emptyTree(tip: string): string { return tip.length === 40 ? emptyTree.sha1 : emptyTree.sha256; }

	async #side(side: BlobSide | undefined): Promise<ChangeFileSide | "binary" | "tooLarge" | undefined> {
		if (!side) return undefined;
		const size = Number(await this.text(["cat-file", "-s", side.hash]));
		if (size > MAX_CHANGE_SIDE_BYTES) return "tooLarge";
		const { stdout } = await this.#read(["cat-file", "blob", side.hash], MAX_CHANGE_SIDE_BYTES);
		if (stdout.includes(0)) return "binary";
		try { return { text: utf8.decode(stdout), hash: side.hash }; }
		catch { return "binary"; }
	}

	async file(range: CommitRange, delta: FileDelta): Promise<FilePayload> {
		const [before, after] = await Promise.all([this.#side(delta.before), this.#side(delta.after)]);
		if (before === "binary" || after === "binary") return { binary: true };
		if (before === "tooLarge" || after === "tooLarge") return this.#patch(range, delta);
		return { ...(before ? { before } : {}), ...(after ? { after } : {}) };
	}

	async #patch({ base, tip }: CommitRange, { file, before, after }: FileDelta): Promise<FilePayload> {
		const empty = this.#emptyTree(tip);
		// A file can be replaced by a directory of the same name. Compare an addition/deletion with the empty tree,
		// not the other commit's tree, so that the patch cannot include that directory's other files.
		const selection = !before ? [empty, tip, "--", `:(top,literal)${file.path}`] :
			!after ? [base!, empty, "--", `:(top,literal)${file.path}`] :
			file.previousPath ? [`${base}:${file.previousPath}`, `${tip}:${file.path}`, "--"] :
			[base!, tip, "--", `:(top,literal)${file.path}`];
		const { stdout, truncated } = await this.#read(["diff", "--no-renames", ...diffOptions, "--submodule=short",
			"--src-prefix=a/", "--dst-prefix=b/", "-U3", ...selection], MAX_CHANGE_PATCH_BYTES, true);
		const bytes = truncated ? stdout.subarray(0, stdout.lastIndexOf(10) + 1) : stdout;
		if (bytes.includes(0)) return { binary: true };
		try {
			const patch = utf8.decode(bytes);
			return { tooLarge: true, patch, ...(truncated ? { patchTruncated: true } : {}) };
		} catch { return { binary: true }; }
	}
}
