/** Backend-wide settings shared by all projects and devices. */
import { type Static, Type } from "typebox";
import { RequestIdSchema } from "./common.ts";

export const USER_NAME_MAX_LENGTH = 80;
export function normalizeUserName(name: string): string {
	const trimmed = name.trim();
	if (trimmed.length > USER_NAME_MAX_LENGTH || /[\p{Cc}\p{Cf}]/u.test(trimmed)) {
		throw new Error("Use a name of at most 80 characters, without control characters.");
	}
	return trimmed;
}
/** Whole percentages of the coordinator model's context window. */
export const CoordinatorCompactionSchema = Type.Object({
	backgroundPercent: Type.Integer({ minimum: 20, maximum: 90 }),
	blockingPercent: Type.Integer({ minimum: 30, maximum: 95 }),
});
export type CoordinatorCompaction = Static<typeof CoordinatorCompactionSchema>;
export const DEFAULT_COORDINATOR_COMPACTION: Readonly<CoordinatorCompaction> = Object.freeze({
	backgroundPercent: 50,
	blockingPercent: 75,
});
export const UsageDrainModeSchema = Type.Union([Type.Literal("pause-and-tell"), Type.Literal("tell-only"), Type.Literal("off")]);
export type UsageDrainMode = Static<typeof UsageDrainModeSchema>;
export const DEFAULT_USAGE_DRAIN_MODE: UsageDrainMode = "pause-and-tell";

export const UserSettingsSchema = Type.Object({
	userName: Type.String({ maxLength: USER_NAME_MAX_LENGTH }),
	coordinatorCompaction: Type.Optional(CoordinatorCompactionSchema),
	usageDrainMode: Type.Optional(UsageDrainModeSchema),
});
export type UserSettings = Static<typeof UserSettingsSchema>;
export const UserSettingsGetRequestSchema = Type.Object({ type: Type.Literal("user.settings.get"), id: RequestIdSchema });
export const UserSettingsSetRequestSchema = Type.Object({
	type: Type.Literal("user.settings.set"),
	id: RequestIdSchema,
	userName: Type.Optional(Type.String()),
	coordinatorCompaction: Type.Optional(CoordinatorCompactionSchema),
	usageDrainMode: Type.Optional(UsageDrainModeSchema),
});
export const UserSettingsGetResponseSchema = Type.Object({ type: Type.Literal("user.settings.get"), id: RequestIdSchema, settings: UserSettingsSchema });
export const UserSettingsSetResponseSchema = Type.Object({ type: Type.Literal("user.settings.set"), id: RequestIdSchema, settings: UserSettingsSchema });
export const UserSettingsChangedEventSchema = Type.Object({ type: Type.Literal("user.settings.changed"), settings: UserSettingsSchema });
export type UserSettingsGetRequest = Static<typeof UserSettingsGetRequestSchema>;
export type UserSettingsSetRequest = Static<typeof UserSettingsSetRequestSchema>;
export type UserSettingsGetResponse = Static<typeof UserSettingsGetResponseSchema>;
export type UserSettingsSetResponse = Static<typeof UserSettingsSetResponseSchema>;
export type UserSettingsChangedEvent = Static<typeof UserSettingsChangedEventSchema>;
