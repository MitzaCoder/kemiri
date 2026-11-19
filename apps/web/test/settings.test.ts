import { describe, expect, test } from "bun:test";
import {
	GENERAL_SECTIONS,
	COMPUTER_SECTIONS,
	PROJECT_SECTIONS,
	backendSettingsHref,
	generalSettingsHref,
	projectSectionAvailable,
	projectAdvancedGroupNote,
	projectHasCodingSettings,
	projectSettingsHref,
	settingsAliasRedirect,
	settingsLocation,
	settingsParentHref,
} from "../src/lib/settings.ts";

describe("settings routes", () => {
	test("every section has a URL of its own", () => {
		expect(generalSettingsHref()).toBe("/settings");
		expect(generalSettingsHref("notifications")).toBe("/settings/notifications");
		expect(backendSettingsHref("harness-pc")).toBe("/settings/backends/harness-pc");
		expect(backendSettingsHref("harness-pc", "accounts")).toBe("/settings/backends/harness-pc/accounts");
		expect(projectSettingsHref("pc", "demo")).toBe("/b/pc/projects/demo/settings");
		expect(projectSettingsHref("pc", "demo", "schedules")).toBe("/b/pc/projects/demo/settings/schedules");
		expect(new Set(GENERAL_SECTIONS.map((s) => s.id)).size).toBe(GENERAL_SECTIONS.length);
		expect(new Set(PROJECT_SECTIONS.map((s) => s.id)).size).toBe(PROJECT_SECTIONS.length);
	});

	test("keeps the shared section order, labels and old segments", () => {
		expect(GENERAL_SECTIONS.map(({ id, label }) => [id, label])).toEqual([
			["appearance", "Appearance"], ["notifications", "Notifications"], ["backends", "Computers"],
			["archived", "Archived projects"], ["about", "About"],
		]);
		expect(COMPUTER_SECTIONS.map(({ id, label }) => [id, label])).toEqual([
			["overview", "Overview"], ["accounts", "AI accounts"], ["you", "You and memory"],
			["mcp", "Connected apps"], ["devices", "Devices"], ["advanced", "Advanced"],
		]);
		expect(PROJECT_SECTIONS.map(({ id, label }) => [id, label])).toEqual([
			["general", "General"], ["coordinator", "Main chat"], ["workers", "Workers"], ["schedules", "Scheduled tasks"],
			["mcp", "Connected apps"], ["skills", "Skills"], ["advanced", "Advanced"],
		]);
		const advanced = projectSettingsHref("pc", "demo", "advanced");
		expect(settingsLocation(advanced)?.section).toBe("advanced");
		expect(settingsParentHref(advanced)).toBe(projectSettingsHref("pc", "demo"));
	});

	test("legacy cache links resolve to the Conversation cache group in Advanced", () => {
		const legacy = new URL("https://example.com/b/a%2Fb/projects/c%20d/settings/cache/?example=1");
		expect(settingsAliasRedirect(legacy)).toBe("/b/a%2Fb/projects/c%20d/settings/advanced?example=1#conversation-cache");
		for (const [section, anchor] of [['tickets', 'tickets'], ['storage', 'storage'], ['delivery', 'code-delivery']]) {
			legacy.pathname = `/b/pc/projects/demo/settings/${section}`;
			expect(settingsAliasRedirect(legacy)).toBe(`/b/pc/projects/demo/settings/advanced?example=1#${anchor}`);
		}
		legacy.pathname = "/b/pc/projects/demo/settings/cache/unknown";
		expect(settingsAliasRedirect(legacy)).toBeUndefined();
		legacy.pathname = "/b/pc/projects/demo/settings/advanced";
		expect(settingsAliasRedirect(legacy)).toBeUndefined();
	});

	test("reads device and computer paths", () => {
		expect(settingsLocation("/settings")).toEqual({ scope: "device", section: undefined, parts: [] });
		expect(settingsLocation("/settings/appearance")).toEqual({ scope: "device", section: "appearance", parts: [] });
		expect(settingsLocation("/settings/backends/a%20b/accounts")).toEqual({
			scope: "computer",
			backendId: "a b",
			section: "accounts",
			parts: [],
		});
		expect(settingsLocation("/settings/nonsense")?.section).toBeUndefined();
	});

	test("reads a project path, decoding the IDs", () => {
		expect(settingsLocation("/b/pc/projects/demo/settings")).toEqual({
			scope: "project",
			backendId: "pc",
			projectId: "demo",
			section: undefined,
			parts: [],
		});
		const found = settingsLocation("/b/a%2Fb/projects/c%20d/settings/coordinator");
		expect(found).toMatchObject({ scope: "project", backendId: "a/b", projectId: "c d", section: "coordinator" });
	});

	test("anything else is not settings", () => {
		expect(settingsLocation("/")).toBeUndefined();
		expect(settingsLocation("/notifications")).toBeUndefined();
		expect(settingsLocation("/b/pc/projects/demo")).toBeUndefined();
		expect(settingsLocation("/b/pc/projects/demo/workers/w1")).toBeUndefined();
	});

	test("the back button goes one level up", () => {
		expect(settingsParentHref("/settings")).toBeUndefined();
		expect(settingsParentHref("/settings/appearance")).toBe("/settings");
		expect(settingsParentHref("/settings/backends")).toBe("/settings");
		expect(settingsParentHref("/settings/backends/pc")).toBe("/settings/backends");
		expect(settingsParentHref("/settings/backends/pc/accounts")).toBe("/settings/backends/pc");
		expect(settingsParentHref("/b/pc/projects/demo/settings")).toBeUndefined();
		expect(settingsParentHref("/b/pc/projects/demo/settings/advanced")).toBe("/b/pc/projects/demo/settings");
		expect(settingsParentHref("/b/pc/projects/demo")).toBeUndefined();
	});

	test("only explicitly non-repository projects hide coding controls and get a Tickets deep link note", () => {
		const supported = { supports: () => true, links: true, longPromptCache: true };
		for (const repository of [undefined, true]) {
			expect(projectHasCodingSettings(repository)).toBe(true);
			expect(projectAdvancedGroupNote("#tickets", repository)).toBeUndefined();
		}
		expect(projectHasCodingSettings(false)).toBe(false);
		expect(projectSectionAvailable("advanced", { ...supported, repository: false })).toBe(true);
		expect(projectAdvancedGroupNote("#storage", false)).toBeUndefined();
		expect(projectAdvancedGroupNote("#tickets", false)).toBe("This project isn't a code repository, so these settings don't apply.");
	});

	test("a project's sections follow what the backend offers", () => {
		const all = { supports: () => true, links: true, longPromptCache: true };
		for (const section of PROJECT_SECTIONS) expect(projectSectionAvailable(section.id, all)).toBe(true);
		const bare = { supports: () => false, links: false, longPromptCache: false };
		expect(PROJECT_SECTIONS.filter((s) => projectSectionAvailable(s.id, bare)).map((s) => s.id)).toEqual(["general"]);
		const noStorage = { ...all, supports: (feature: string) => feature !== "storage" };
		expect(projectSectionAvailable("advanced", noStorage)).toBe(true);
		expect(projectSectionAvailable("advanced", { ...bare, supports: feature => feature === "storage" })).toBe(true);
	});

	test("cache support alone makes Advanced available, even for non-repository projects", () => {
		const cacheOnly = { supports: () => false, links: false, longPromptCache: true, repository: false };
		expect(PROJECT_SECTIONS.filter((s) => projectSectionAvailable(s.id, cacheOnly)).map((s) => s.id)).toEqual(["general", "advanced"]);
	});
});
