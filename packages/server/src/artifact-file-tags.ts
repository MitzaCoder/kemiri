import { ARTIFACT_MAX_TAG_LENGTH } from "@kemiri/protocol";
import { basename, extname } from "node:path";

/** Tags after the last `--`, before the final extension (if any). Invalid/empty words are ignored, not repaired. */
export function artifactTagsFromFileName(path: string): string[] {
	const name = basename(path);
	const stem = name.slice(0, name.length - extname(name).length);
	const separator = stem.lastIndexOf("--");
	if (separator < 0) return [];
	return stem.slice(separator + 2).toLowerCase().split("-")
		.filter((tag) => /^[a-z0-9]+$/.test(tag) && tag.length <= ARTIFACT_MAX_TAG_LENGTH);
}
