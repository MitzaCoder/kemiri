import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const component = (name: string) => readFileSync(new URL(`../src/lib/components/${name}.svelte`, import.meta.url), "utf8");

describe("conversation panels", () => {
	test("the shared desktop and phone shell keeps navigation and controls in one labelled bar", () => {
		const sidebar = component("ConversationSidebar");
		expect(sidebar).not.toContain('role="tablist"');
		expect(sidebar).not.toContain('role="tab"');
		expect(sidebar).not.toContain('role="tabpanel"');
		expect(sidebar).toContain('role="region"');
		expect(sidebar).toContain('aria-labelledby="sidebar-heading"');
		expect(sidebar).toContain('<h2 id="sidebar-heading"');
		expect(sidebar).toContain('<Dialog.Title id="sidebar-heading"');
		expect(sidebar).toContain('aria-label="Close the sidebar"');
		const panelBar = sidebar.match(/<header class="project-topbar[\s\S]*?<\/header>/)?.[0];
		expect(panelBar).toContain("{@render panelTabs()}");
		expect(panelBar).toContain("{@render panelControls(sheet)}");
		expect(panelBar).not.toContain("sidebar-heading");
	});

	test("main and thread chats leave panel tabs to the panel and keep overlay actions in the chat bar", () => {
		const chat = component("ProjectChat");
		const actions = chat.slice(chat.indexOf("const headerActions"), chat.indexOf("const shownHeaderActions"));
		for (const tab of ["board", "answers", "background", "info", "artifacts", "memory"]) {
			expect(actions).not.toContain(`id: '${tab}'`);
		}
		for (const action of ["files", "working-changes", "terminal", "settings", "panel"]) {
			expect(actions).toContain(`id: '${action}'`);
		}
		expect(chat).toContain("shownHeaderActions.menu as action");
		expect(chat).toContain("aria-expanded={sidebarOpen}");
		expect(chat).toContain("!sidebarOpen && taskAttentionBadge");
		expect(chat).toContain("selectSidebar(sidebarTab)");
		expect(chat).toContain("{ background: true, answers: supportsAnswers }");
		expect(chat).toContain("panelTabs={sidebarPanelTabs}");
	});

	test("worker transcripts retain their own context and memory toggles", () => {
		const worker = component("WorkerTranscript");
		for (const panel of ["info", "memory"]) {
			expect(worker).toContain(`onclick={() => toggleSidebar('${panel}')}`);
			expect(worker).toContain(`aria-pressed={sidebarOpen && sidebarTab === '${panel}'}`);
		}
		expect(worker.match(/aria-pressed:bg-muted/g)).toHaveLength(2);
		expect(worker).toContain("<ConversationSidebar");
	});
});
