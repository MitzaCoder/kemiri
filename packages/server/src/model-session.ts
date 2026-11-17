import { randomUUID } from "node:crypto";

/** One opaque provider-facing identity per internal run. Reuse it for every round; never encode paths or secrets. */
export function newModelSessionId(): string {
	return randomUUID();
}
