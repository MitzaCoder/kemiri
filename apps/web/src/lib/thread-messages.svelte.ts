import type { ThreadMessage } from '@kemiri/protocol';
import type { HarnessClient } from '@kemiri/client';

/** One project log, shared by both chat cards and all three feeds. */
export class ProjectThreadMessages {
	messages = $state.raw<readonly ThreadMessage[]>([]);
	loaded = $state(false);
	error = $state(false);
	readonly #stop: (() => void)[];
	#load = 0;

	constructor(client: HarnessClient, projectId: string) {
		const duringRead = new Map<string, ThreadMessage>();
		const update = (messages: ThreadMessage[]) => {
			for (const message of messages) duringRead.set(message.id, message);
			const updates = new Map(messages.map(message => [message.id, message]));
			this.messages = [...messages.filter(message => !this.messages.some(old => old.id === message.id)),
				...this.messages.map(message => updates.get(message.id) ?? message)].slice(0, 300);
		};
		const loadMessages = (state: HarnessClient["state"]) => {
			const load = ++this.#load;
			if (state.status !== 'ready') return;
			duringRead.clear();
			void client.threadMessages(projectId, { limit: 300 }).then(({ messages }) => {
				if (load !== this.#load) return;
				const ids = new Set(messages.map(message => message.id));
				this.messages = [...[...duringRead.values()].reverse().filter(message => !ids.has(message.id)),
					...messages.map(message => duringRead.get(message.id) ?? message)].slice(0, 300);
				this.loaded = true;
				this.error = false;
			}, () => { if (load === this.#load) this.error = true; });
		};
		this.#stop = [client.onThreadMessage(event => {
			if (event.projectId !== projectId) return;
			update(event.answeredRequest ? [event.message, event.answeredRequest] : [event.message]);
		}), client.subscribe(loadMessages)];
		loadMessages(client.state);
	}

	stop() { this.#load++; for (const stop of this.#stop) stop(); }
}
