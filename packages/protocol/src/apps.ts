import { Type, type Static } from "typebox";

const AddressOffSchema = Type.Object({ mode: Type.Literal("off") });
const AddressTemplateSchema = Type.Object({ mode: Type.Literal("template"), template: Type.String({ minLength: 1, maxLength: 2048 }) });
const AddressTailscaleServeSchema = Type.Object({ mode: Type.Literal("tailscale-serve"), startPort: Type.Integer(), endPort: Type.Integer() });
export const AppAddressesSchema = Type.Union([AddressOffSchema, AddressTemplateSchema, AddressTailscaleServeSchema]);
export const DEFAULT_TAILSCALE_SERVE_RANGE = { startPort: 47300, endPort: 47319 } as const;

const TailscaleStatusLineSchema = Type.Object({ ok: Type.Boolean(), message: Type.String() });
const TailscaleAppStatusSchema = Type.Object({
	hostname: Type.Union([Type.String(), Type.Null()]),
	installed: TailscaleStatusLineSchema,
	running: TailscaleStatusLineSchema,
	magicDns: TailscaleStatusLineSchema,
	https: TailscaleStatusLineSchema,
	operator: TailscaleStatusLineSchema,
});
export type TailscaleAppStatus = Static<typeof TailscaleAppStatusSchema>;
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
	state: Type.Union([Type.Literal("live"), Type.Literal("stopped"), Type.Literal("pending"), Type.Literal("unpublished")]),
	taskId: Type.Optional(Type.String()),
	publishedBy: AppPublisherSchema,
	ownerPublished: Type.Optional(Type.Boolean()),
	createdAt: Type.String(),
	mode: Type.Union([Type.Literal("off"), Type.Literal("template"), Type.Literal("tailscale-serve")]),
	addressMessage: Type.Optional(Type.String()),
});
export type ProjectApp = Static<typeof ProjectAppSchema>;

export const DetectedAppPortSchema = Type.Object({ port: Type.Integer({ minimum: 1024, maximum: 65535 }) });
export type DetectedAppPort = Static<typeof DetectedAppPortSchema>;

const Id = Type.String({ minLength: 1 });
export const AppsListRequestSchema = Type.Object({ type: Type.Literal("apps.list"), id: Id, projectId: Id });
export const AppsListResponseSchema = Type.Object({ type: Type.Literal("apps.list"), id: Id, apps: Type.Array(ProjectAppSchema),
	detected: Type.Optional(Type.Array(DetectedAppPortSchema)), listenerChecksAvailable: Type.Optional(Type.Boolean()),
});
export const AppsAllowRequestSchema = Type.Object({ type: Type.Literal("apps.allow"), id: Id, projectId: Id, appId: Id });
export const AppsAllowResponseSchema = Type.Object({ type: Type.Literal("apps.allow"), id: Id, app: ProjectAppSchema });
export const AppsUnpublishRequestSchema = Type.Object({ type: Type.Literal("apps.unpublish"), id: Id, projectId: Id, appId: Id });
export const AppsUnpublishResponseSchema = Type.Object({ type: Type.Literal("apps.unpublish"), id: Id, app: ProjectAppSchema });
export const AppsPublishDetectedRequestSchema = Type.Object({ type: Type.Literal("apps.publishDetected"), id: Id, projectId: Id, ...DetectedAppPortSchema.properties });
export const AppsPublishDetectedResponseSchema = Type.Object({ type: Type.Literal("apps.publishDetected"), id: Id, app: ProjectAppSchema });
export const AppsIgnoreDetectedRequestSchema = Type.Object({ type: Type.Literal("apps.ignoreDetected"), id: Id, projectId: Id, ...DetectedAppPortSchema.properties });
export const AppsIgnoreDetectedResponseSchema = Type.Object({ type: Type.Literal("apps.ignoreDetected"), id: Id });
export const AppsSettingsGetRequestSchema = Type.Object({ type: Type.Literal("apps.settings.get"), id: Id });
export const AppsSettingsGetResponseSchema = Type.Object({ type: Type.Literal("apps.settings.get"), id: Id, settings: AppSettingsSchema, tailscale: Type.Optional(TailscaleAppStatusSchema) });
export const AppsSettingsSetRequestSchema = Type.Object({ type: Type.Literal("apps.settings.set"), id: Id, settings: AppSettingsSchema });
export const AppsSettingsSetResponseSchema = Type.Object({ type: Type.Literal("apps.settings.set"), id: Id, settings: AppSettingsSchema });
export const AppsChangedEventSchema = Type.Object({ type: Type.Literal("apps.changed"), projectId: Id });
export const AppsSettingsChangedEventSchema = Type.Object({ type: Type.Literal("apps.settings.changed"), settings: AppSettingsSchema });
