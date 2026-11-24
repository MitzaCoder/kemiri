import type { ClientState, HarnessClient } from '@kemiri/client';
import type { Answer } from '@kemiri/protocol';
import { answerRequests, answersSupported, hasUnreadAnswers } from './answers.ts';

/** One project catalogue shared by all its retained chats, independent of the sidebar search. */
export class ProjectAnswers {
	answers = $state.raw<readonly Answer[]>([]);
	loaded = $state(false);
	error = $state<string>();
	ready = $state(false);
	readonly unread = $derived(hasUnreadAnswers(this.answers));
	readonly requests: ReturnType<typeof answerRequests>;
	#stopEvents: () => void;
	#stopConnection: () => void;
	#catalogueRead: Promise<void> | undefined;
	#refreshQueued = false;
	#connectionRevision = 0;

	constructor(readonly client: HarnessClient, readonly projectId: string) {
		this.requests = answerRequests(client, projectId);
		this.#stopEvents = client.onAnswersChanged(event => {
			if (event.projectId === projectId) this.refresh();
		});
		const observeConnection = (state: ClientState) => {
			const ready = state.status === 'ready' && answersSupported(state.features);
			if (this.ready === ready) return;
			this.ready = ready;
			this.#connectionRevision++;
			this.#catalogueRead = undefined;
			this.#refreshQueued = false;
			if (ready) this.refresh(true);
		};
		this.#stopConnection = client.subscribe(observeConnection);
		observeConnection(client.state);
	}

	refresh(subscribe?: true): void {
		if (!this.ready) return;
		if (this.#catalogueRead) { this.#refreshQueued = true; return; }
		const revision = this.#connectionRevision;
		this.#catalogueRead = this.requests.list(undefined, subscribe).then(answers => {
			if (revision !== this.#connectionRevision) return;
			this.answers = answers;
			this.loaded = true;
			this.error = undefined;
		}, error => {
			if (revision === this.#connectionRevision) this.error = error instanceof Error ? error.message : String(error);
		}).finally(() => {
			if (revision !== this.#connectionRevision) return;
			this.#catalogueRead = undefined;
			if (this.#refreshQueued) { this.#refreshQueued = false; this.refresh(); }
		});
	}

	stop(): void {
		this.#stopEvents();
		this.#stopConnection();
		if (this.ready) void this.requests.list(undefined, false).catch(() => {});
		this.ready = false;
		this.#connectionRevision++;
	}
}
