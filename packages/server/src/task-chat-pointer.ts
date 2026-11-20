export const CHAT_POINTER_WARNING = "\nThis points at the chat. The user reads the task: write the answer or detail here.";

// End the reference at "chat" or a direction like "above", not at "chat composer" or "chat list".
const referenceEnd = String.raw`\b(?=\s*(?:$|[.,!?:;)\]>*_\x60]|(?:above|below|for)\b))`;
const chatDestination = String.raw`(?:(?:the|this|main|the main)\s+)?chat${referenceEnd}`;
const chatPointers = [
	new RegExp(String.raw`\b(?:see|refer to|check|read)\s+${chatDestination}`, "im"),
	new RegExp(String.raw`\b(?:answer(?:ed)?|explained|covered|described|discussed|posted|shared|provided|listed|noted|said|wrote|given|reply|details?|steps|commands|instructions)(?:\s+(?:it|that|this|you|is|are|was|were))?\s+in\s+${chatDestination}`, "im"),
	new RegExp(String.raw`\bin\s+(?:my|our|the|this)\s+(?:(?:earlier|previous|last)\s+)?chat\s+(?:reply|message)${referenceEnd}`, "im"),
];

/** Does the task text direct its reader to the chat instead of giving the detail here? */
export function pointsAtChat(text: string | undefined): boolean {
	return text !== undefined && chatPointers.some(pointer => pointer.test(text));
}
