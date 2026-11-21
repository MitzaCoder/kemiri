import { Type, type Static } from "typebox";

const AddressOffSchema = Type.Object({ mode: Type.Literal("off") });
const AddressTemplateSchema = Type.Object({ mode: Type.Literal("template"), template: Type.String({ minLength: 1, maxLength: 2048 }) });
export const AppAddressesSchema = Type.Union([AddressOffSchema, AddressTemplateSchema]);
export const AppSettingsSchema = Type.Object({
	addresses: AppAddressesSchema,
	policy: Type.Union([Type.Literal("off"), Type.Literal("ask"), Type.Literal("on")]),
});
export type AppSettings = Static<typeof AppSettingsSchema>;
export type AppAddresses = AppSettings["addresses"];
export const DEFAULT_APP_SETTINGS: AppSettings = { addresses: { mode: "off" }, policy: "ask" };

export const AppPublisherSchema = Type.Object({
	id: Type.String(),
	kind: Type.Union([Type.Literal("worker"), Type.Literal("thread"), Type.Literal("coordinator")]),
	threadId: Type.String(),
	conversationId: Type.Integer(),
});
export type AppPublisher = Static<typeof AppPublisherSchema>;
export const ProjectAppSchema = Type.Object({
	appId: Type.String(),
	projectId: Type.String(),
	name: Type.String(),
	port: Type.Integer({ minimum: 1024, maximum: 65535 }),
	path: Type.String(),
	url: Type.Union([Type.String(), Type.Null()]),
	state: Type.Union([Type.Literal("live"), Type.Literal("pending"), Type.Literal("unpublished")]),
	taskId: Type.Optional(Type.String()),
	publishedBy: AppPublisherSchema,
	createdAt: Type.String(),
	mode: Type.Union([Type.Literal("off"), Type.Literal("template")]),
});
export type ProjectApp = Static<typeof ProjectAppSchema>;

const Id = Type.String({ minLength: 1 });
export const AppsListRequestSchema = Type.Object({ type: Type.Literal("apps.list"), id: Id, projectId: Id });
export const AppsListResponseSchema = Type.Object({ type: Type.Literal("apps.list"), id: Id, apps: Type.Array(ProjectAppSchema) });
export const AppsAllowRequestSchema = Type.Object({ type: Type.Literal("apps.allow"), id: Id, projectId: Id, appId: Id });
export const AppsAllowResponseSchema = Type.Object({ type: Type.Literal("apps.allow"), id: Id, app: ProjectAppSchema });
export const AppsUnpublishRequestSchema = Type.Object({ type: Type.Literal("apps.unpublish"), id: Id, projectId: Id, appId: Id });
export const AppsUnpublishResponseSchema = Type.Object({ type: Type.Literal("apps.unpublish"), id: Id, app: ProjectAppSchema });
export const AppsSettingsGetRequestSchema = Type.Object({ type: Type.Literal("apps.settings.get"), id: Id });
export const AppsSettingsGetResponseSchema = Type.Object({ type: Type.Literal("apps.settings.get"), id: Id, settings: AppSettingsSchema });
export const AppsSettingsSetRequestSchema = Type.Object({ type: Type.Literal("apps.settings.set"), id: Id, settings: AppSettingsSchema });
export const AppsSettingsSetResponseSchema = Type.Object({ type: Type.Literal("apps.settings.set"), id: Id, settings: AppSettingsSchema });
export const AppsChangedEventSchema = Type.Object({ type: Type.Literal("apps.changed"), projectId: Id });
export const AppsSettingsChangedEventSchema = Type.Object({ type: Type.Literal("apps.settings.changed"), settings: AppSettingsSchema });
