import { defineDoc } from "@earendil-works/pi-durable";
import type { ThreadMessage } from "@kemiri/protocol";
import { stateKind } from "./state-identity.ts";

export const THREAD_MESSAGE_ENTRY = "kemiri.thread-message";
export const THREAD_MESSAGE_LIMIT = 300;

export const ThreadMessagesDoc = defineDoc<{ messages: ThreadMessage[] }>({
	kind: stateKind("thread-messages"),
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	checkpointWhen: () => false,
	initial: () => ({ messages: [] }),
});
