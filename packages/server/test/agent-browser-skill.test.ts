import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentBrowserCommandLookup } from "../src/agent-browser.ts";
import { builtinSkillAvailable, builtinSkillFiles, builtinSkillsDirectory } from "../src/builtin-skills.ts";
import { loadAgentContext, renderSkills } from "../src/context.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { packagedResources } from "../src/packaged-resources.ts";
import { ProjectSkillStore } from "../src/skills.ts";

const source = join(import.meta.dir, "../skills");
const skillPath = "agent-browser/SKILL.md";

test("agent-browser is a short, project-independent lazy skill shipped by the binary asset enumerator", () => {
	const files = builtinSkillFiles(source);
	expect(files[skillPath]).toBe(join(source, skillPath));
	const body = readFileSync(files[skillPath]!, "utf8");
	const { frontmatter } = parseFrontmatter(body);
	expect(frontmatter.name).toBe("agent-browser");
	expect(frontmatter.description).toMatch(/web UI/);
	expect(frontmatter.description).toMatch(/screenshots.*recordings/);
	expect(Buffer.byteLength(body)).toBeLessThanOrEqual(6000);
	expect(body).not.toMatch(/kemiri|aiki|\/home\/|\/Users\/|\/etc\/profiles\/|\/nix\/store\//i);
	expect(body).not.toContain("localStorage[");
	for (const instruction of ["AGENT_BROWSER_SOCKET_DIR", "AGENT_BROWSER_SESSION", "AGENT_BROWSER_EXECUTABLE_PATH",
		"AGENT_BROWSER_NO_VERSION_CHECK", "AGENT_BROWSER_ALLOWED_DOMAINS", "timeout 30s", "snapshot -i",
		"storage local set", "wait --text", "set media dark", "record start", "record stop", "ab close"]) {
		expect(body).toContain(instruction);
	}
});

for (const compiled of [false, true]) {
	for (const available of [false, true]) {
		test(`${compiled ? "packaged" : "source"} skill is ${available ? "offered" : "absent"} in both catalogues`, () => {
			const root = mkdtempSync(join(tmpdir(), "browser-skill-test-"));
			try {
				if (compiled) packagedResources.skills = builtinSkillFiles(source);
				const loaded = loadAgentContext({
					agentDir: root, configDir: root, claudeDir: root, cwd: root, homeDir: root,
					agentBrowserCommand: () => available ? "/opt/tools/agent-browser" : null,
				});
				const skill = loaded.skills.find(skill => skill.name === "agent-browser");
				expect(skill !== undefined).toBe(available);
				expect(renderSkills(loaded.skills)!.includes("<name>agent-browser</name>")).toBe(available);
				const catalogue = new ProjectSkillStore(root).list("project-test", loaded.skills);
				expect(catalogue.some(skill => skill.name === "agent-browser")).toBe(available);
				expect(catalogue.find(skill => skill.name === "html-artifacts")?.origin).toBe("builtin");
				if (skill) {
					expect(skill.origin).toBe("builtin");
					expect(skill.path).toBe(join(builtinSkillsDirectory(root), skillPath));
					expect(readFileSync(skill.path)).toEqual(readFileSync(join(source, skillPath)));
					expect(renderSkills(loaded.skills)).not.toContain("Isolate every call");
				}
			} finally {
				delete packagedResources.skills;
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
}

test("unavailable bundled browser does not gate personal or project overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "browser-skill-test-"));
	try {
		const directory = join(root, ".agents/skills/agent-browser");
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "SKILL.md"), "---\nname: agent-browser\ndescription: Project browser instructions.\n---\n");
		const loaded = loadAgentContext({
			agentDir: root, configDir: root, claudeDir: root, cwd: root, homeDir: join(root, "home"),
			agentBrowserCommand: () => null,
		});
		const skill = loaded.skills.find(skill => skill.name === "agent-browser");
		expect(skill?.origin).toBe("project");
		expect(skill?.description).toBe("Project browser instructions.");
		expect(skill?.hides).toEqual([]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

for (const initial of [null, "/opt/tools/agent-browser"]) {
	test(`command discovery caches ${initial === null ? "misses" : "successes"} until server restart`, () => {
		let calls = 0;
		const lookup = createAgentBrowserCommandLookup(() => { calls++; return calls === 1 ? initial : "/changed"; });
		expect(lookup()).toBe(initial);
		expect(lookup()).toBe(initial);
		expect(calls).toBe(1);
		expect(builtinSkillAvailable("agent-browser", lookup)).toBe(initial !== null);
		expect(builtinSkillAvailable("html-artifacts", () => { throw new Error("must stay unconditional"); })).toBe(true);
	});
}
