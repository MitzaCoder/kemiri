/**
 * Settings, split in two: General settings (this browser and its backends) and Project settings (one project). Both
 * are a list of sections, and every section has its own URL, so a link, a banner or a notification can open the right
 * one and Android can map the same names one to one. Pure helpers, no runes: the routes, the sidebar and the tests
 * share them. docs/DESIGN.md "Settings" says what each section holds.
 */
import { projectHref } from "./backends.ts";

/** The name of a lucide icon a section uses; the shell maps it to the component. */
export type SettingsIconName =
	| "palette"
	| "server"
	| "bell"
	| "archive"
	| "folder"
	| "cpu"
	| "users"
	| "calendar-clock"
	| "ticket"
	| "hard-drive"
	| "key-round"
	| "settings";

export type SettingsSectionInfo<Id extends string = string> = {
	/** The last URL segment, and the name Android uses for the same screen. */
	id: Id;
	label: string;
	term?: string;
	/** One line, shown under the label in the phone's list. */
	hint: string;
	icon: SettingsIconName;
};

export const COMPUTER_ACCOUNTS = {
	label: "AI accounts", term: "Accounts and API keys", hint: "Sign in to AI providers or add API keys so agents can run.",
};
export const COMPUTER_APPS = {
	label: "Connected apps", term: "MCP servers", hint: "Outside tools agents can use, such as issue trackers or docs.",
};

export const GENERAL_SECTIONS = [
	{ id: "appearance", label: "Appearance", hint: "Theme, light or dark, time and reading", icon: "palette" },
	{ id: "backends", label: "Computers", term: "Backends", hint: "The computers running Kemiri, their AI accounts and apps", icon: "server" },
	{ id: "notifications", label: "Notifications", hint: "What reaches this device, and when", icon: "bell" },
	{ id: "archived", label: "Archived projects", hint: "Bring a project back", icon: "archive" },
	{ id: "about", label: "About", hint: "Kemiri versions and updates", icon: "settings" },
] as const satisfies readonly SettingsSectionInfo[];

export type GeneralSectionId = (typeof GENERAL_SECTIONS)[number]["id"];

export const PROJECT_SECTIONS = [
	{ id: "general", label: "General", hint: "Name, folder, archive", icon: "folder" },
	{ id: "coordinator", label: "Main chat", term: "Coordinator", hint: "The model the main chat runs on", icon: "cpu" },
	{ id: "workers", label: "Workers", hint: "Worker models and check-ins", icon: "users" },
	{ id: "schedules", label: "Scheduled tasks", hint: "Clocks and event triggers", icon: "calendar-clock" },
	{ id: "mcp", label: "Connected apps", term: "MCP", hint: "Which outside tools this project's agents may use", icon: "server" },
	{ id: "skills", label: "Skills", hint: "What this project's agents know how to do", icon: "key-round" },
	{ id: "tickets", label: "Tickets and pull requests", hint: "Turn ticket keys and PR numbers into links", icon: "ticket" },
	{ id: "storage", label: "Storage", hint: "Finished workspaces and disk use", icon: "hard-drive" },
	{ id: "advanced", label: "Advanced", hint: "Page privacy, conversation cache, proof of screen changes, report checks, live lines, code delivery", icon: "settings" },
] as const satisfies readonly SettingsSectionInfo[];

export function projectSection(id: ProjectSectionId): SettingsSectionInfo<ProjectSectionId> {
	return PROJECT_SECTIONS.find((section) => section.id === id)!;
}

export type ProjectSectionId = (typeof PROJECT_SECTIONS)[number]["id"];

export function isGeneralSection(value: unknown): value is GeneralSectionId {
	return GENERAL_SECTIONS.some((section) => section.id === value);
}

export function isProjectSection(value: unknown): value is ProjectSectionId {
	return PROJECT_SECTIONS.some((section) => section.id === value);
}

/** General settings: the section index, or the entry point for the wide default. */
export const GENERAL_SETTINGS_HREF = "/settings";

export function generalSettingsHref(section?: GeneralSectionId): string {
	return section === undefined ? GENERAL_SETTINGS_HREF : `${GENERAL_SETTINGS_HREF}/${section}`;
}

/** One backend's own page, or one of its subpages. */
export function backendSettingsHref(backendId: string, sub?: "accounts" | "mcp"): string {
	const base = `${GENERAL_SETTINGS_HREF}/backends/${encodeURIComponent(backendId)}`;
	return sub === undefined ? base : `${base}/${sub}`;
}

/** A project's settings: the section index or one section. */
export function projectSettingsHref(backendId: string, projectId: string, section?: ProjectSectionId): string {
	const base = `${projectHref(backendId, projectId)}/settings`;
	return section === undefined ? base : `${base}/${section}`;
}

export const CONVERSATION_CACHE_GROUP_ID = "conversation-cache";

/** Resolve legacy section URLs independently of viewport width and entry history. */
export function settingsAliasRedirect(url: Pick<URL, 'pathname' | 'search'>): string | undefined {
	const location = settingsLocation(url.pathname);
	if (location?.scope !== "project") return;
	const index = projectSettingsHref(location.backendId, location.projectId);
	if (url.pathname.replace(/\/$/, '') === `${index}/cache`) {
		return `${index}/advanced${url.search}#${CONVERSATION_CACHE_GROUP_ID}`;
	}
}

/** Resolve a fresh index entry only. Real sections and content-bearing drill-downs are not indexes. */
export function settingsEntryRedirect(url: Pick<URL, 'pathname' | 'search' | 'hash'>, split: boolean): string | undefined {
	const path = url.pathname.replace(/\/$/, '');
	const location = settingsLocation(path);
	if (path === GENERAL_SETTINGS_HREF && split) {
		return generalSettingsHref(GENERAL_SECTIONS[0].id) + url.search + url.hash;
	}
	if (location?.scope !== "project" || path !== projectSettingsHref(location.backendId, location.projectId)) return;
	// Old schedule notification URLs point at the project index with a fragment, even on phones.
	const section = url.hash.startsWith("#schedule-") ? "schedules" : split ? PROJECT_SECTIONS[0].id : undefined;
	if (section) return projectSettingsHref(location.backendId, location.projectId, section) + url.search + url.hash;
}

export type SettingsLocation =
	| { scope: "general"; section: GeneralSectionId | undefined; parts: string[] }
	| { scope: "project"; backendId: string; projectId: string; section: ProjectSectionId | undefined; parts: string[] };

function decode(part: string): string | undefined {
	try {
		return decodeURIComponent(part);
	} catch {
		return undefined;
	}
}

/**
 * Where a path sits in settings: the scope, the section it opens (undefined on the list) and the segments after the
 * section (a backend's ID and subpage). Anything that is not a settings path gives undefined.
 */
export function settingsLocation(pathname: string): SettingsLocation | undefined {
	const parts = pathname.split("/").filter((part) => part.length > 0);
	if (parts[0] === "settings") {
		const section = parts[1];
		if (section === undefined) return { scope: "general", section: undefined, parts: [] };
		return { scope: "general", section: isGeneralSection(section) ? section : undefined, parts: parts.slice(2) };
	}
	if (parts[0] === "b" && parts[2] === "projects" && parts[4] === "settings") {
		const backendId = decode(parts[1] ?? "");
		const projectId = decode(parts[3] ?? "");
		if (backendId === undefined || projectId === undefined) return undefined;
		const section = parts[5];
		return {
			scope: "project",
			backendId,
			projectId,
			section: isProjectSection(section) ? section : undefined,
			parts: parts.slice(6),
		};
	}
	return undefined;
}

/**
 * The screen one step up from a path, for the named Up control: a backend's subpage goes to the backend, the backend
 * to the Backends list, a section to the list of sections. Undefined on the list itself.
 */
export function settingsParentHref(pathname: string): string | undefined {
	const location = settingsLocation(pathname);
	if (location === undefined || location.section === undefined) return undefined;
	if (location.scope === "general") {
		if (location.section === "backends" && location.parts.length > 1) {
			return backendSettingsHref(decode(location.parts[0] ?? "") ?? "");
		}
		if (location.section === "backends" && location.parts.length === 1) return generalSettingsHref("backends");
		return GENERAL_SETTINGS_HREF;
	}
	return projectSettingsHref(location.backendId, location.projectId);
}

export function projectHasCodingSettings(repository?: boolean): boolean {
	return repository !== false;
}

/** A hidden coding-only page is still a valid settings destination. */
export function projectSectionNote(section: ProjectSectionId, repository?: boolean): string | undefined {
	if (section === 'tickets' && !projectHasCodingSettings(repository)) {
		return "This project isn't a code repository, so these settings don't apply.";
	}
}

/** Whether a section is shown for a backend, by the features it advertises; the list drops the rest. */
export function projectSectionAvailable(
	section: ProjectSectionId,
	has: { supports: (feature: string) => boolean; links: boolean; longPromptCache: boolean; pagePrivacy?: boolean; repository?: boolean },
): boolean {
	switch (section) {
		case "general":
			return true;
		case "advanced":
			return has.pagePrivacy === true || has.longPromptCache || has.supports("report-audit") || has.supports("task-live-watcher") ||
				(projectHasCodingSettings(has.repository) && ["ui-proof", "task-changes", "task-deploys"].some((feature) => has.supports(feature)));
		case "coordinator":
			return has.supports("projects") && has.supports("models");
		case "workers":
			return has.supports("projects") && has.supports("models") && has.supports("workers");
		case "schedules":
			return has.supports("schedules");
		case "tickets":
			return has.links && projectHasCodingSettings(has.repository);
		case "mcp":
			return has.supports("mcp-servers");
		case "skills":
			return has.supports("project-skills");
		case "storage":
			return has.supports("storage");
	}
}
