/** A route-scoped, single-flight reader. An invalidated response must not request another page or publish. */
export class ArtifactLibraryRefresh {
	#active = false;
	#loading = false;
	#pending = false;
	#revision = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly load: (isCurrent: () => boolean) => Promise<void>, private readonly debounceMs = 450) {}

	setActive(active: boolean) {
		if (active === this.#active) return;
		this.#active = active;
		if (active) this.refresh();
		else {
			clearTimeout(this.#timer);
			this.#pending = false;
			this.#revision++;
		}
	}

	artifactsChanged() {
		if (!this.#active) return;
		this.#revision++;
		this.#pending = false;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.refresh(), this.debounceMs);
	}

	refresh() {
		if (!this.#active) return;
		clearTimeout(this.#timer);
		this.#revision++;
		this.#pending = true;
		void this.#loadPending();
	}

	async #loadPending(): Promise<void> {
		while (this.#active && this.#pending && !this.#loading) {
			this.#pending = false;
			this.#loading = true;
			const revision = this.#revision;
			try {
				await this.load(() => this.#active && revision === this.#revision);
			} finally {
				this.#loading = false;
			}
		}
	}
}
