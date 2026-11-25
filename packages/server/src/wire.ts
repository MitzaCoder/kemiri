/** Durable records carry branded numeric IDs; the wire uses plain numbers. */
import type {
	ConversationRecord as DurableConversationRecord,
	EntryRecord as DurableEntryRecord,
} from "@earendil-works/pi-durable";
import type { ConversationRecord, EntryRecord } from "@kemiri/protocol";
import { acpToolLabel, acpToolStep } from "./official-agents/acp-activity.ts";

import { THREAD_MESSAGE_ENTRY } from "./thread-messages.ts";

/** Durable provenance for chat submitted by a client, projected as the existing user entry on the wire. */
export const OWNER_CHAT_ENTRY = "kemiri.owner-chat";
/** A separate model-facing block; not part of the owner's note in the transcript. */
export const FEEDBACK_QUESTION_CHECK_PREFIX = "[board] Check open questions against this task note.\n";

function withoutFeedbackQuestionChecks(content: unknown): unknown {
	return Array.isArray(content) ? content.filter(block => block?.type !== "text" ||
		typeof block.text !== "string" || !block.text.startsWith(FEEDBACK_QUESTION_CHECK_PREFIX)) : content;
}

export function wireEntry(entry: DurableEntryRecord): EntryRecord {
	const step = acpToolStep(entry);
	// Reuse the transcript's evidence anchor, without making a model-facing or executable tool result.
	if (step) return { id: entry.id, conversationId: entry.conversationId, kind: "pi.tool-result", model: [{
		role: "toolResult", toolCallId: `acp-entry-${entry.id}`, toolName: step.kind, timestamp: step.at,
		isError: step.status === "failed", content: [{ type: "text", text: `${acpToolLabel(step.kind)} (${step.status.replace("_", " ")})` }],
	}] };
	const userInput = entry.kind === OWNER_CHAT_ENTRY;
	const model = userInput ? entry.model?.map(message => message.role === "user" ?
		{ ...message, content: withoutFeedbackQuestionChecks(message.content) } : message) : entry.model;
	const data = entry.data as { peerDisplayContent?: unknown } | undefined;
	return {
		id: entry.id,
		conversationId: entry.conversationId,
		kind: (entry.kind === OWNER_CHAT_ENTRY || entry.kind === THREAD_MESSAGE_ENTRY) ? "pi.user" : entry.kind,
		...(model === undefined ? {} : { model: model as unknown[] }),
		...(data === undefined ? {} : { data: userInput && data?.peerDisplayContent !== undefined ?
			{ ...data, peerDisplayContent: withoutFeedbackQuestionChecks(data.peerDisplayContent) } : data }),
		...(entry.head === undefined ? {} : { head: entry.head }),
		...(entry.edits === undefined ? {} : { edits: entry.edits as unknown[] }),
		...(entry.byTaskId === undefined ? {} : { byTaskId: entry.byTaskId }),
	};
}

export function wireConversation(record: DurableConversationRecord): ConversationRecord {
	return {
		id: record.id,
		...(record.parent === undefined
			? {}
			: { parent: { conversationId: record.parent.conversationId, at: record.parent.at } }),
		...(record.owner === undefined
			? {}
			: {
					owner: {
						conversationId: record.owner.conversationId,
						taskId: record.owner.taskId,
					},
				}),
	};
}
