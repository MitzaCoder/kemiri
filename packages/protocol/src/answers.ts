import { type Static, Type } from "typebox";
import { ProjectIdSchema, RequestIdSchema } from "./common.ts";

export const AnswerIdSchema = Type.String({ pattern: "^A[1-9][0-9]*$" });

export const AnswerExchangeSchema = Type.Object({
	question: Type.String(),
	answer: Type.String(),
	at: Type.String(),
	coordinatorId: Type.String(),
	coordinatorTitle: Type.String(),
	filedBy: Type.Union([Type.Literal("coordinator"), Type.Literal("harness")]),
	questionEntryId: Type.Optional(Type.Integer()),
	entryId: Type.Optional(Type.Integer({ description: "The final reply in the answering coordinator's chat." })),
});
export type AnswerExchange = Static<typeof AnswerExchangeSchema>;

export const AnswerWorkSchema = Type.Object({
	workerId: Type.Optional(Type.String()),
	status: Type.Optional(Type.Union([Type.Literal("running"), Type.Literal("failed"), Type.Literal("stopped"), Type.Literal("awaiting_reply"), Type.Literal("unavailable")])),
	elapsedMinutes: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type AnswerWork = Static<typeof AnswerWorkSchema>;

export const TaskAnswerQuestionSchema = Type.Object({
	taskId: Type.String(),
	feedbackId: Type.String(),
	question: Type.String(),
	note: Type.Optional(Type.String()),
	at: Type.String(),
});
export type TaskAnswerQuestion = Static<typeof TaskAnswerQuestionSchema>;

export const AnswerSchema = Type.Object({
	...AnswerExchangeSchema.properties,
	id: AnswerIdSchema,
	title: Type.String(),
	related: Type.Array(Type.String()),
	taskId: Type.Optional(Type.String({ description: "The request made from or copied to this answer." })),
	working: Type.Optional(AnswerWorkSchema),
	pinned: Type.Boolean(),
	read: Type.Boolean(),
	exchanges: Type.Array(AnswerExchangeSchema, { description: "Earlier exchanges, newest first. The latest is on the answer itself." }),
});
export type Answer = Static<typeof AnswerSchema>;

const request = { id: RequestIdSchema, projectId: ProjectIdSchema };
const answerRequest = { ...request, answerId: AnswerIdSchema };
export const AnswersListRequestSchema = Type.Object({
	type: Type.Literal("answers.list"), ...request,
	query: Type.Optional(Type.String()),
	subscribe: Type.Optional(Type.Boolean({ description: "Set or clear this connection's subscription to answers.changed for the project." })),
});
export const AnswersGetRequestSchema = Type.Object({ type: Type.Literal("answers.get"), ...answerRequest });
export const AnswersUpdateRequestSchema = Type.Object({
	type: Type.Literal("answers.update"), ...answerRequest,
	pinned: Type.Optional(Type.Boolean()), read: Type.Optional(Type.Boolean()),
});
export const AnswersDeleteRequestSchema = Type.Object({ type: Type.Literal("answers.delete"), ...answerRequest });
export const AnswersAskRequestSchema = Type.Object({
	type: Type.Literal("answers.ask"), ...answerRequest,
	requestId: Type.String({ minLength: 1, description: "A stable owner input ID for retries." }),
	question: Type.Optional(Type.String({ minLength: 1, description: "Follow-up text. Omit to ask the original question again." })),
});
export const AnswersTurnIntoTaskRequestSchema = Type.Object({
	type: Type.Literal("answers.turnIntoTask"), ...answerRequest,
	title: Type.Optional(Type.String({ minLength: 1 })),
	description: Type.Optional(Type.String()),
});

export const AnswersCopyFromTaskRequestSchema = Type.Object({
	type: Type.Literal("answers.copyFromTask"), ...request, taskId: Type.String(),
});
export const AnswersCopyFromTaskResponseSchema = Type.Object({
	type: Type.Literal("answers.copyFromTask"), id: RequestIdSchema, answerId: AnswerIdSchema,
});
export type AnswersCopyFromTaskRequest = Static<typeof AnswersCopyFromTaskRequestSchema>;
export type AnswersCopyFromTaskResponse = Static<typeof AnswersCopyFromTaskResponseSchema>;

export const AnswersListResponseSchema = Type.Object({ type: Type.Literal("answers.list"), id: RequestIdSchema, answers: Type.Array(AnswerSchema), taskQuestions: Type.Optional(Type.Array(TaskAnswerQuestionSchema)) });
export const AnswersGetResponseSchema = Type.Object({ type: Type.Literal("answers.get"), id: RequestIdSchema, answer: AnswerSchema });
export const AnswersUpdateResponseSchema = Type.Object({ type: Type.Literal("answers.update"), id: RequestIdSchema, answer: AnswerSchema });
export const AnswersDeleteResponseSchema = Type.Object({ type: Type.Literal("answers.delete"), id: RequestIdSchema });
export const AnswersAskResponseSchema = Type.Object({ type: Type.Literal("answers.ask"), id: RequestIdSchema, coordinatorId: Type.String() });
export const AnswersTurnIntoTaskResponseSchema = Type.Object({ type: Type.Literal("answers.turnIntoTask"), id: RequestIdSchema, taskId: Type.String() });
export const AnswersChangedEventSchema = Type.Object({
	type: Type.Literal("answers.changed"), projectId: ProjectIdSchema, answerId: AnswerIdSchema,
	deleted: Type.Optional(Type.Literal(true)),
});

export type AnswersListRequest = Static<typeof AnswersListRequestSchema>;
export type AnswersListResponse = Static<typeof AnswersListResponseSchema>;
export type AnswersGetRequest = Static<typeof AnswersGetRequestSchema>;
export type AnswersGetResponse = Static<typeof AnswersGetResponseSchema>;
export type AnswersUpdateRequest = Static<typeof AnswersUpdateRequestSchema>;
export type AnswersUpdateResponse = Static<typeof AnswersUpdateResponseSchema>;
export type AnswersDeleteRequest = Static<typeof AnswersDeleteRequestSchema>;
export type AnswersDeleteResponse = Static<typeof AnswersDeleteResponseSchema>;
export type AnswersAskRequest = Static<typeof AnswersAskRequestSchema>;
export type AnswersAskResponse = Static<typeof AnswersAskResponseSchema>;
export type AnswersTurnIntoTaskRequest = Static<typeof AnswersTurnIntoTaskRequestSchema>;
export type AnswersTurnIntoTaskResponse = Static<typeof AnswersTurnIntoTaskResponseSchema>;
export type AnswersChangedEvent = Static<typeof AnswersChangedEventSchema>;
