type UsageComputer = { id: string };
export type UsageRead<C, T> = { computer: C; loading: boolean; report?: T; error?: string };
type PendingUsageRead<C, T> = { ready: boolean; read: UsageRead<C, T> };

/** Retain each computer's last successful report for this query, independently of its connection. */
export class UsageReads<C extends UsageComputer, T> {
	#scope: string | undefined;
	#refreshRevision: number | undefined;
	#byComputer = new Map<string, PendingUsageRead<C, T>>();

	constructor(private readonly publish: (scope: string, reads: UsageRead<C, T>[]) => void) {}

	sync(scope: string, targets: { computer: C; ready: boolean }[], refreshRevision: number, load: (computer: C) => Promise<T>): void {
		let changed = scope !== this.#scope;
		if (changed) this.#byComputer.clear();
		this.#scope = scope;
		const refresh = refreshRevision !== this.#refreshRevision;
		this.#refreshRevision = refreshRevision;
		const selected = new Set(targets.map(({ computer }) => computer.id));
		for (const id of this.#byComputer.keys()) {
			if (!selected.has(id)) changed = this.#byComputer.delete(id) || changed;
		}
		for (const { computer, ready } of targets) {
			const previous = this.#byComputer.get(computer.id);
			const sameComputer = previous?.read.computer === computer;
			if (sameComputer && previous.ready === ready && !(ready && refresh)) continue;
			const entry = { ready, read: { computer, loading: ready, report: sameComputer ? previous.read.report : undefined } };
			this.#byComputer.set(computer.id, entry);
			changed = true;
			if (ready) void this.#load(scope, entry, load);
		}
		if (changed) this.#publish(scope);
	}

	#publish(scope: string): void {
		this.publish(scope, Array.from(this.#byComputer.values(), entry => entry.read));
	}

	async #load(scope: string, entry: PendingUsageRead<C, T>, load: (computer: C) => Promise<T>): Promise<void> {
		const { computer, report } = entry.read;
		let completed: UsageRead<C, T>;
		try {
			completed = { computer, loading: false, report: await load(computer) };
		} catch (error) {
			completed = { computer, loading: false, report, error: error instanceof Error ? error.message : 'could not be read' };
		}
		if (this.#byComputer.get(computer.id) !== entry) return;
		entry.read = completed;
		this.#publish(scope);
	}

	stop(): void {
		this.#byComputer.clear();
	}
}
