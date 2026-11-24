import type { ClientState, HarnessClient } from '@kemiri/client';
import type { Answer, TaskAnswerQuestion } from '@kemiri/protocol';
import { answerRequests, answersSupported, answersWorkAndTasksSupported, hasUnreadAnswers } from './answers.ts';

/** One project catalogue shared by all its retained chats, independent of the sidebar search. */
export class ProjectAnswers {
	answers = $state.raw<readonly Answer[]>([]);
	taskQuestions = $state.raw<readonly TaskAnswerQuestion[]>([]);
	loaded = $state(false);
	error = $state<string>();
	ready = $state(false);
	readonly unread = $derived(hasUnreadAnswers(this.answers));
	readonly requests: ReturnType<typeof answerRequests>;
	#stopEvents: (() => void)[];
	#stopConnection: () => void;
	#catalogueRead: Promise<void> | undefined;
	#refreshQueued = false;
	#connectionRevision = 0;
	#supportsWorkAndTasks = false;

	constructor(readonly client: HarnessClient, readonly projectId: string) {
		this.requests = answerRequests(client, projectId);
		let feedbackRevisions: string | undefined;
		this.#stopEvents = [
			client.onAnswersChanged(event => { if (event.projectId === projectId) this.refresh(); }),
			client.onBoardState(event => {
				if (event.projectId !== projectId || !this.#supportsWorkAndTasks) return;
				const revisions = event.board.tasks.filter(task => task.feedback).map(task => `${task.id}:${task.timelineRevision}`).join(',');
				if (revisions === feedbackRevisions) return;
				feedbackRevisions = revisions;
				this.refresh();
			}),
			client.onWorkersState(event => {
				if (event.projectId === projectId && this.answers.some(answer => answer.working?.workerId)) this.refresh();
			}),
		];
		const observeConnection = (state: ClientState) => {
			this.#supportsWorkAndTasks = state.status === 'ready' && answersWorkAndTasksSupported(state.features);
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
		this.#catalogueRead = this.requests.list(undefined, subscribe).then(({ answers, taskQuestions }) => {
			if (revision !== this.#connectionRevision) return;
			this.answers = answers;
			this.taskQuestions = taskQuestions;
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
		for (const stop of this.#stopEvents) stop();
		this.#stopConnection();
		if (this.ready) void this.requests.list(undefined, false).catch(() => {});
		this.ready = false;
		this.#connectionRevision++;
	}
}
