/** Backend-wide, optional identity used in agent instructions. */
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
export const UserSettingsSchema = Type.Object({ userName: Type.String({ maxLength: USER_NAME_MAX_LENGTH }) });
export type UserSettings = Static<typeof UserSettingsSchema>;
export const UserSettingsGetRequestSchema = Type.Object({ type: Type.Literal("user.settings.get"), id: RequestIdSchema });
export const UserSettingsSetRequestSchema = Type.Object({ type: Type.Literal("user.settings.set"), id: RequestIdSchema, userName: Type.String() });
export const UserSettingsGetResponseSchema = Type.Object({ type: Type.Literal("user.settings.get"), id: RequestIdSchema, settings: UserSettingsSchema });
export const UserSettingsSetResponseSchema = Type.Object({ type: Type.Literal("user.settings.set"), id: RequestIdSchema, settings: UserSettingsSchema });
export const UserSettingsChangedEventSchema = Type.Object({ type: Type.Literal("user.settings.changed"), settings: UserSettingsSchema });
export type UserSettingsGetRequest = Static<typeof UserSettingsGetRequestSchema>;
export type UserSettingsSetRequest = Static<typeof UserSettingsSetRequestSchema>;
export type UserSettingsGetResponse = Static<typeof UserSettingsGetResponseSchema>;
export type UserSettingsSetResponse = Static<typeof UserSettingsSetResponseSchema>;
export type UserSettingsChangedEvent = Static<typeof UserSettingsChangedEventSchema>;
