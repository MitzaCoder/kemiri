/** Least recent first. Speculative warmups must never evict a visited chat. */
export function retainCoordinator(ids: readonly string[], id: string, limit: number, prefetch = false): readonly string[] {
	if (prefetch) return ids.includes(id) || ids.length >= limit ? ids : [id, ...ids];
	if (ids.at(-1) === id) return ids;
	return [...ids.filter(retained => retained !== id), id].slice(-limit);
}
