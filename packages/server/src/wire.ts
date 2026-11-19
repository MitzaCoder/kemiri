/** Durable records carry branded numeric IDs; the wire uses plain numbers. */
import type {
	ConversationRecord as DurableConversationRecord,
	EntryRecord as DurableEntryRecord,
} from "@earendil-works/pi-durable";
import type { ConversationRecord, EntryRecord } from "@kemiri/protocol";
import { acpToolLabel, acpToolStep } from "./official-agents/acp-activity.ts";

/** Durable provenance for chat submitted by a client, projected as the existing user entry on the wire. */
export const OWNER_CHAT_ENTRY = "kemiri.owner-chat";

export function wireEntry(entry: DurableEntryRecord): EntryRecord {
	const step = acpToolStep(entry);
	// Reuse the transcript's evidence anchor, without making a model-facing or executable tool result.
	if (step) return { id: entry.id, conversationId: entry.conversationId, kind: "pi.tool-result", model: [{
		role: "toolResult", toolCallId: `acp-entry-${entry.id}`, toolName: step.kind, timestamp: step.at,
		isError: step.status === "failed", content: [{ type: "text", text: `${acpToolLabel(step.kind)} (${step.status.replace("_", " ")})` }],
	}] };
	return {
		id: entry.id,
		conversationId: entry.conversationId,
		kind: entry.kind === OWNER_CHAT_ENTRY ? "pi.user" : entry.kind,
		...(entry.model === undefined ? {} : { model: entry.model as unknown[] }),
		...(entry.data === undefined ? {} : { data: entry.data }),
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
