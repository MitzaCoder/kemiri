/** Thumbnails are deliberately cheaper than the full, 20 MiB page reader. */
export const PAGE_PREVIEW_BYTES = 1024 * 1024;

/** Bounds live frames, not merely simultaneous downloads. A hidden preview releases its slot. */
export class PagePreviewPool {
	private live = 0;
	private waiting = new Set<() => void>();
	constructor(private readonly limit: number) {
		if (!Number.isInteger(limit) || limit < 1) throw new Error('A preview pool needs a positive limit');
	}
	reserve(start: () => void): () => void {
		let held = false;
		const acquire = () => {
			if (this.live < this.limit) { this.waiting.delete(acquire); this.live++; held = true; start(); }
		};
		this.waiting.add(acquire); acquire();
		return () => {
			this.waiting.delete(acquire);
			if (held) { this.live--; held = false; for (const next of this.waiting) next(); }
		};
	}
}
export const pagePreviewPool = new PagePreviewPool(4);
