import { describe, expect, it } from "bun:test";
import { pointsAtChat } from "../src/task-chat-pointer.ts";

describe("pointsAtChat", () => {
	it.each([
		"Answered in chat",
		"See chat.",
		"Explained in the chat.",
		"As I said in chat, the reason is already there.",
		"Details in chat above",
		"In my chat reply.",
		"The commands are in the main chat below.",
		"See my answer in chat for the commands.",
		"- Check the chat for the steps.",
		"## Next\n**See chat**\n",
		"Details are in my earlier chat message.",
	])("recognizes a pointer: %s", (text) => {
		expect(pointsAtChat(text)).toBe(true);
	});

	it.each([
		undefined,
		"",
		"The chat composer now scrolls.",
		"Main chat label renamed.",
		"Fixed the chat list.",
		"Check the chat composer on a small screen.",
		"Listed in chat settings.",
		"The instructions in chat support now link to the help page.",
		"Fixed wrapping in the chat message bubble.",
		"Chat now shows the full answer.",
	])("ignores other text: %s", (text) => {
		expect(pointsAtChat(text)).toBe(false);
	});
});
