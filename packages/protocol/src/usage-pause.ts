import { Type, type Static } from "typebox";
import { RequestIdSchema } from "./common.ts";

const ProviderLoginSchema = Type.String({ minLength: 1, maxLength: 128, description: "The backend's subscription credential slot, not a model ID." });

export const UsagePauseSchema = Type.Object({
	providerLogin: ProviderLoginSchema,
	pausedBy: Type.Union([Type.Literal("owner"), Type.Literal("limit-reached"), Type.Literal("drain-monitor")]),
	reason: Type.String({ minLength: 1, maxLength: 512 }),
	since: Type.String({ format: "date-time" }),
	until: Type.Optional(Type.String({ format: "date-time" })),
	drain: Type.Optional(Type.Object({
		status: Type.Union([Type.Literal("investigating"), Type.Literal("needs-choice"), Type.Literal("kept-paused")]),
		projectId: Type.Optional(Type.String()),
		questionId: Type.Optional(Type.String()),
	})),
});
export type UsagePause = Static<typeof UsagePauseSchema>;

export const UsagePauseGetRequestSchema = Type.Object({ type: Type.Literal("usage-pause.get"), id: RequestIdSchema });
export const UsagePausePauseRequestSchema = Type.Object({
	type: Type.Literal("usage-pause.pause"), id: RequestIdSchema, providerLogin: ProviderLoginSchema,
});
export const UsagePauseResumeRequestSchema = Type.Object({
	type: Type.Literal("usage-pause.resume"), id: RequestIdSchema, providerLogin: ProviderLoginSchema,
});
const state = { id: RequestIdSchema, pauses: Type.Array(UsagePauseSchema) };
export const UsagePauseGetResponseSchema = Type.Object({ type: Type.Literal("usage-pause.get"), ...state });
export const UsagePausePauseResponseSchema = Type.Object({ type: Type.Literal("usage-pause.pause"), ...state });
export const UsagePauseResumeResponseSchema = Type.Object({ type: Type.Literal("usage-pause.resume"), ...state });
export const UsagePauseEventSchema = Type.Object({ type: Type.Literal("usage-pause.changed"), pauses: Type.Array(UsagePauseSchema) });
