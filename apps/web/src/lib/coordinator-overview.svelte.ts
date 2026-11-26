import type { HarnessClient } from '@kemiri/client';
import type { Overview } from '@kemiri/protocol';

/** One subscription per project socket. Warm, hidden chats share this instance. */
export class ProjectOverview {
	#snapshots = $state.raw(new Map<string | null, Overview>());
	error = $state<string>();
	#scope: string | null | undefined;
	#lease: object | undefined;
	#generation = 0;
	#stopped = false;
	#stopState: () => void;
	#stopEvents: () => void;

	constructor(private client: Pick<HarnessClient, 'request' | 'onOverview' | 'subscribe' | 'state'>, private projectId: string) {
		this.#stopEvents = client.onOverview(snapshot => {
			if (!this.#stopped && snapshot.scope.projectId === projectId && snapshot.scope.coordinatorId === this.#scope) this.#accept(snapshot);
		});
		this.#stopState = client.subscribe(state => {
			if (state.status === 'ready' && this.#scope !== undefined) void this.#subscribe(this.#scope);
		});
	}

	read(scope: string | null): Overview | undefined { return this.#snapshots.get(scope); }

	follow(scope: string | null): () => void {
		const lease = {};
		this.#lease = lease;
		if (this.#scope !== scope) {
			this.#scope = scope;
			void this.#subscribe(scope);
		}
		return () => queueMicrotask(() => {
			// A scope change, or switching between mounted chats, replaces the old subscription directly.
			if (!this.#stopped && this.#lease === lease) this.#unfollow();
		});
	}

	async #subscribe(scope: string | null): Promise<void> {
		const generation = ++this.#generation;
		this.error = undefined;
		if (!this.#ready()) return;
		try {
			const reply = await this.client.request({ type: 'overview.get', projectId: this.projectId, coordinatorId: scope, subscribe: true });
			if (generation !== this.#generation) return;
			if (reply.type === 'error') throw new Error(reply.error.message);
			if (reply.type === 'overview') this.#accept(reply);
		} catch (error) {
			if (generation === this.#generation) this.error = error instanceof Error ? error.message : String(error);
		}
	}

	#accept(snapshot: Overview) {
		const scope = snapshot.scope.coordinatorId;
		const before = this.#snapshots.get(scope);
		if (before && before.asOf > snapshot.asOf) return;
		this.#snapshots = new Map(this.#snapshots).set(scope, snapshot);
	}

	#ready(): boolean { return this.client.state.status === 'ready' && this.client.state.features?.includes('coordinator-overview') === true; }

	#unfollow() {
		const scope = this.#scope;
		++this.#generation;
		this.#scope = undefined;
		this.#lease = undefined;
		if (scope !== undefined && this.#ready()) void this.client.request({ type: 'overview.get', projectId: this.projectId, coordinatorId: scope, subscribe: false }).catch(() => {});
	}

	stop() {
		this.#stopped = true;
		this.#stopEvents();
		this.#stopState();
		this.#unfollow();
	}
}
