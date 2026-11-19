import { type Static, Type } from "typebox";
import { RequestIdSchema } from "./common.ts";

const NullableNumber = Type.Union([Type.Number(), Type.Null()]);
const NullableString = Type.Union([Type.String(), Type.Null()]);
const Month = Type.String({ pattern: "^[1-9][0-9]{3}-(0[1-9]|1[0-2])$", description: "Calendar month, YYYY-MM." });
const MonthlyPrice = Type.Number({ exclusiveMinimum: 0, description: "Monthly USD price." });
const SubscriptionBilling = Type.Union([Type.Literal("subscription"), Type.Literal("plan_key"), Type.Literal("agent")]);

export const SubscriptionPriceSchema = Type.Object({
	kind: Type.Union([Type.Literal("default"), Type.Literal("owner"), Type.Literal("none")]),
	monthlyPrice: Type.Union([MonthlyPrice, Type.Null()]),
	checkedOn: NullableString,
	source: NullableString,
});
export type SubscriptionPrice = Static<typeof SubscriptionPriceSchema>;

export const ValueRangeSchema = Type.Object({
	estimate: Type.Number(),
	low: Type.Number(),
	high: Type.Union([Type.Number(), Type.Null()], { description: "Null when the upper bound is unbounded." }),
});
export const WindowValueSchema = Type.Object({
	windowId: Type.String(),
	label: Type.String(),
	scope: NullableString,
	windowMinutes: NullableNumber,
	binding: Type.Boolean(),
	windowsPerMonth: NullableNumber,
	kemiriPoints: Type.Number({ description: "Points in the periods pooled for the estimate." }),
	elsewherePoints: Type.Number({ description: "Use elsewhere across all observed periods, including excluded ones." }),
	elsewhereShare: NullableNumber,
	periods: Type.Integer(),
	excludedNoisyPeriods: Type.Integer(),
	valuePerPoint: Type.Union([ValueRangeSchema, Type.Null()], { description: "Null below 5 pooled points (not enough use yet)." }),
	fullWindowValue: Type.Union([ValueRangeSchema, Type.Null()]),
});
export type WindowValue = Static<typeof WindowValueSchema>;

export const ModelValueSchema = Type.Object({
	model: Type.String(),
	apiValue: Type.Number(),
	scopedWindowId: NullableString,
	valuePerPoint: Type.Union([ValueRangeSchema, Type.Null()]),
});
export const TopTaskValueSchema = Type.Object({
	projectId: Type.String(),
	taskId: Type.String(),
	title: Type.String(),
	apiValue: Type.Number({ description: "Includes descendants via parent links only." }),
});
export type TopTaskValue = Static<typeof TopTaskValueSchema>;

export const SubscriptionValueSchema = Type.Object({
	providerId: Type.String(),
	label: Type.String(),
	plan: NullableString,
	billing: SubscriptionBilling,
	price: SubscriptionPriceSchema,
	apiValue: Type.Number(),
	realisedRatio: NullableNumber,
	fullUseRatio: NullableNumber,
	planUsed: NullableNumber,
	windows: Type.Array(WindowValueSchema),
	models: Type.Array(ModelValueSchema),
	topTasks: Type.Array(TopTaskValueSchema),
	assumed: Type.Boolean(),
});
export type SubscriptionValue = Static<typeof SubscriptionValueSchema>;

export const PayAsYouGoValueSchema = Type.Object({
	providerId: Type.String(),
	label: Type.String(),
	cost: Type.Number(),
	assumed: Type.Boolean(),
});

export const UsageValueRequestSchema = Type.Object({
	type: Type.Literal("usage.value"),
	id: RequestIdSchema,
	month: Type.Optional(Month),
	utcOffsetMinutes: Type.Integer({ minimum: -840, maximum: 840, description: "Minutes east of UTC." }),
});
export type UsageValueRequest = Static<typeof UsageValueRequestSchema>;
export const UsageValueResponseSchema = Type.Object({
	type: Type.Literal("usage.value"),
	id: RequestIdSchema,
	month: Month,
	subscriptions: Type.Array(SubscriptionValueSchema),
	payAsYouGo: Type.Array(PayAsYouGoValueSchema),
	unpricedRequests: Type.Integer(),
	assumed: Type.Boolean(),
	approximateMonth: Type.Boolean({ description: "Old daily-only roll-ups cross a local month boundary." }),
	ledgerSince: NullableString,
});
export type UsageValueResponse = Static<typeof UsageValueResponseSchema>;

export const TaskUsageAmountSchema = Type.Object({
	requests: Type.Integer({ minimum: 0 }),
	apiValue: Type.Number({ description: "Catalog value of all requests, including pay-as-you-go." }),
});
export type TaskUsageAmount = Static<typeof TaskUsageAmountSchema>;

export const TaskUsagePartSchema = Type.Object({
	taskId: Type.String(),
	parentTaskId: Type.String(),
	title: Type.String(),
	total: TaskUsageAmountSchema,
});
export type TaskUsagePart = Static<typeof TaskUsagePartSchema>;

export const TaskSubscriptionUsageSchema = Type.Object({
	providerId: Type.String(),
	label: Type.String(),
	billing: SubscriptionBilling,
	apiValue: Type.Number(),
	bindingWindow: Type.Union([Type.Object({
		label: Type.String(),
		windowMinutes: NullableNumber,
		share: Type.Number({ description: "Estimated fraction of one binding window; can exceed 1." }),
	}), Type.Null()]),
	assumed: Type.Boolean(),
});
export type TaskSubscriptionUsage = Static<typeof TaskSubscriptionUsageSchema>;

export const TaskConversationUsageSchema = Type.Object({
	kind: Type.Union([Type.Literal("worker"), Type.Literal("thread")]),
	threadId: NullableString,
	workerId: NullableString,
	name: Type.String(),
	providerId: Type.String(),
	model: Type.String(),
	apiValue: Type.Number(),
});
export type TaskConversationUsage = Static<typeof TaskConversationUsageSchema>;

export const TaskUsageNotesSchema = Type.Object({
	unpricedRequests: Type.Integer({ minimum: 0 }),
	missingLimitShare: Type.Array(Type.String()),
});

export const UsageTaskRequestSchema = Type.Object({
	type: Type.Literal("usage.task"),
	id: RequestIdSchema,
	projectId: Type.String({ minLength: 1 }),
	taskId: Type.String({ minLength: 1 }),
});
export const UsageTaskResponseSchema = Type.Object({
	type: Type.Literal("usage.task"),
	id: RequestIdSchema,
	own: TaskUsageAmountSchema,
	total: TaskUsageAmountSchema,
	parts: Type.Array(TaskUsagePartSchema, { description: "Descendants in board order within each parent, depth first." }),
	subscriptions: Type.Array(TaskSubscriptionUsageSchema),
	payAsYouGo: Type.Array(PayAsYouGoValueSchema),
	conversations: Type.Array(TaskConversationUsageSchema),
	notes: TaskUsageNotesSchema,
});
export type UsageTaskResponse = Static<typeof UsageTaskResponseSchema>;

export const SubscriptionsPriceSetRequestSchema = Type.Object({
	type: Type.Literal("subscriptions.price.set"),
	id: RequestIdSchema,
	providerId: Type.String({ minLength: 1 }),
	monthlyPrice: Type.Union([MonthlyPrice, Type.Null()]),
});
export const SubscriptionsPriceSetResponseSchema = Type.Object({
	type: Type.Literal("subscriptions.price.set"),
	id: RequestIdSchema,
	providerId: Type.String(),
	price: SubscriptionPriceSchema,
});
