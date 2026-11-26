import { expect, test } from "bun:test";
import {
	decryptRelay, encryptRelay, newRelayId, parseRelayFcmData, prepareRelayPlaintext, PUSH_RELAY_LIMITS,
	PROTOCOL_SCHEMAS,
} from "@kemiri/protocol";
import { Value } from "typebox/value";
import { boardQuestionNotification, notificationPayload, sharedSubscriptionLimitKey, usageLimitReachedNotification } from "../src/notifications.ts";

const at = "2026-11-26T09:00:00.000Z";
const baseQuestion = { projectId: "garden", projectName: "Garden export", coordinatorId: "main", coordinatorTitle: "General",
	questionId: "Q4", questionRevision: 7, taskId: "T12", taskTitle: "Write the export", taskRevision: 8,
	text: "Should the export include old seeds?\n\nUse **active only** to skip them.",
	choices: [{ label: "Include old seeds" }, { label: "Active only", recommended: true }] };

test("sends the exact question revision and recommended choice first; warns and approvals have no choices", () => {
	const payload = (event = baseQuestion) => notificationPayload({ backendKey: "https://studio.example.test" }, boardQuestionNotification(event), at, "Studio");
	expect(payload().question).toEqual({ id: "Q4", revision: 7, quickAnswerAllowed: true,
		choices: [{ label: "Active only", recommended: true }, { label: "Include old seeds", recommended: false }] });
	expect(payload().message).toBe("Should the export include old seeds?\n\nUse active only to skip them.");
	expect(payload().taskRevision).toBe(8);
	expect(payload({ ...baseQuestion, choices: [{ label: "🍞".repeat(25) }] }).question).toEqual({ id: "Q4", revision: 7, quickAnswerAllowed: false });
	expect(payload({ ...baseQuestion, choices: [{ label: "Same" }, { label: "Same" }] }).question?.choices).toBeUndefined();
	expect(payload({ ...baseQuestion, choices: Array.from({ length: 4 }, (_, index) => ({ label: `Choice ${index}` })) }).question?.choices).toBeUndefined();
	expect(notificationPayload({ backendKey: "studio" }, boardQuestionNotification({ ...baseQuestion, approval: true }), at).question)
		.toEqual({ id: "Q4", revision: 7, quickAnswerAllowed: false, approval: true });
	expect(notificationPayload({ backendKey: "studio" }, boardQuestionNotification({ ...baseQuestion, warning: true }), at).question?.choices).toBeUndefined();
	expect(Value.Check(PROTOCOL_SCHEMAS.NotificationPayload, payload())).toBe(true);
});

test("an upper-end rich question fills a real relay frame without losing its route or exact choices", async () => {
	const payload = notificationPayload({ backendKey: `https://${"workspace-edge-".repeat(6)}gateway.example.test:4810` },
		boardQuestionNotification({ ...baseQuestion,
			projectName: 'Bakery site – "Regional order processing"', projectId: `project-${"f".repeat(32)}`, coordinatorId: `thread-${"a".repeat(32)}`,
			coordinatorTitle: "The order processing and fulfilment coordinator", taskTitle: "Keep the basket after a reload and resume the order",
			threadId: `thread-${"b".repeat(32)}`, text: `Keep the current settings?\n\n${'Review “stock 🍞” and "fixed" labels. '.repeat(95)}`,
			choices: ["Use current bench setup", "🍞".repeat(24), 'Use "fixed" variant now'].map((label, i) => ({ label, recommended: i === 1 })),
		}), at, "Studio build and benchmark workstation");
	const context = { backendId: newRelayId(), sessionId: newRelayId(), routeId: newRelayId(), keyId: newRelayId() };
	const options = { backendId: context.backendId, sessionId: context.sessionId, sequence: "99999999999", eventId: newRelayId(),
		createdAt: Date.parse(at), expiresAt: Date.parse(at) + 60_000, payload };
	const prepared = prepareRelayPlaintext(options);
	expect(prepared.padded.byteLength).toBe(PUSH_RELAY_LIMITS.plaintext);
	const key = crypto.getRandomValues(new Uint8Array(32));
	const envelope = await encryptRelay(key, context, options);
	const fcmData = JSON.stringify({ aiki: envelope });
	expect(Buffer.byteLength(fcmData)).toBeLessThanOrEqual(PUSH_RELAY_LIMITS.fcmData);
	expect(parseRelayFcmData(fcmData).r).toBe(context.routeId);
	const clear = (await decryptRelay(key, context, envelope)).payload;
	expect(clear.question).toEqual(payload.question);
	for (const field of ["backendKey", "tag", "taskId", "taskTitle", "threadId", "projectName", "coordinatorName", "computerName", "key"] as const) {
		expect(clear[field]).toBe(payload[field]);
	}
	expect(typeof clear.message).toBe("string");
	const preview = clear.message as string;
	expect(preview.length).toBeGreaterThan(150);
	expect(preview.length).toBeLessThan(payload.message!.length);
	expect(preview).toBe(preview.toWellFormed());
});

test("correlates only known accounts and the same subscription window, without sending the account label", () => {
	const account = { providerId: "anthropic", account: "Sample@Example.test", plan: "Max" };
	const identity = sharedSubscriptionLimitKey("test-owner", "usage_limit_reached", account, at);
	expect(identity).toBeDefined();
	expect(sharedSubscriptionLimitKey("other-owner", "usage_limit_reached", account, at)).not.toBe(identity);
	expect(sharedSubscriptionLimitKey("test-owner", "usage_limit_reached", { ...account, account: " sample@example.test " }, at)).toBe(identity);
	expect(sharedSubscriptionLimitKey("test-owner", "usage_limit_reached", { ...account, account: "other@example.test" }, at)).not.toBe(identity);
	expect(sharedSubscriptionLimitKey("test-owner", "usage_limit_reached", account, "2026-11-26T11:00:00.000Z")).not.toBe(identity);
	expect(sharedSubscriptionLimitKey("test-owner", "usage_limit_reached", { ...account, account: null }, at)).toBeUndefined();
	expect(sharedSubscriptionLimitKey("test-owner", "usage_limit_reached", account, undefined)).toBeUndefined();
	expect(sharedSubscriptionLimitKey("test-owner", "usage_drain_warning", account, at, "weekly")).not.toBe(sharedSubscriptionLimitKey("test-owner", "usage_drain_warning", account, at, "short"));
	const push = notificationPayload({ backendKey: "studio" }, usageLimitReachedNotification({ providerLogin: "anthropic", label: "Claude",
		reason: "Claude limit reached", since: at, until: at, sharedLimitKey: identity! }), at, "Studio");
	expect(push.sharedLimitKey).toBe(identity);
	expect(push.expiresAt).toBe(at);
	expect(JSON.stringify(push)).not.toContain(account.account);
});
