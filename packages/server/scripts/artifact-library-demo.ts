/** Synthetic Vitrine backend. Run with Bun; SIGINT/SIGTERM removes the fixture's temporary data. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { BoardTaskInput } from "@kemiri/protocol";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { ArtifactSaveInput } from "../src/artifacts.ts";
import { BoardDoc } from "../src/board.ts";
import { createSetup, errorOf, TestClient } from "../test/support.ts";

const origins = (process.env.DEMO_ORIGINS ?? "http://localhost:5210,http://localhost:5211").split(",");
const output = process.env.DEMO_OUTPUT ?? "/tmp/artifact-library-demo.json";
let now = Date.now() - 10 * 86400000;
const setup = await createSetup({ allowedOrigins: origins, terminals: false, now: () => now });
let client: TestClient | undefined;
try {
	client = await TestClient.open(setup.server);
	await client.hello();
	setup.faux.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage("This is a synthetic demo. The seasonal guide is ready to read.")));
	const projectSpecs = [
		{ name: "Fern Street Library", path: setup.projectDir, archived: false, home: "Publish the seasonal guide", later: "Clarify the meeting point", review: "Check the next seasonal update", guide: "Seasonal guide", notes: "Print notes", pair: "Wayfinding" },
		{ name: "Harbor Garden", path: join(setup.root, "garden"), archived: false, home: "Plan the spring garden", later: "Move the seedling beds", review: "Review the watering plan", guide: "Spring garden plan", notes: "Planting notes", pair: "Garden layout" },
		{ name: "Paper Lantern Archive", path: join(setup.root, "archive"), archived: true, home: "Share the autumn reading list", later: "Update the reading room signs", review: "Check the next reading list", guide: "Autumn reading list", notes: "Reading notes", pair: "Reading room signs" },
	];
	const projects = [];
	for (const spec of projectSpecs) {
		await mkdir(spec.path, { recursive: true });
		const added = await client.request({ type: "projects.add", path: spec.path });
		if (added.type !== "projects.add") throw errorOf(added);
		const projectId = added.project.id;
		const configured = await client.request({ type: "projects.configure", projectId, name: spec.name, coordinatorModel: { provider: "faux", modelId: "faux-1" } });
		if (configured.type !== "projects.configure") throw errorOf(configured);
		const { runtime } = await setup.server.manager.open(projectId);
		const addTask = (title: string, status: BoardTaskInput["status"], foundWhile: string | null = null) => runtime.board.saveTask({
			task: { title, status, foundWhile, description: "An invented task for the artifact library demo.", acceptance: null, blockedBy: [], blockedReason: null, writeScopes: [] },
		}, "user");
		const home = await addTask(spec.home, "done");
		await runtime.board.writeReport(change => runtime.harness.commit(change, BACKGROUND_CONTEXT), {
			taskId: home.id, sections: { summary: "Published a short seasonal guide with routes and accessible meeting points." },
			by: { author: "coordinator", threadId: null, workerId: null },
		}, "seasonal-guide-report");
		const store = setup.server.manager.artifacts;
		const save = async (name: string, contents: string | Uint8Array, changes: Partial<ArtifactSaveInput> = {}) => {
			const sourcePath = join(spec.path, name);
			await writeFile(sourcePath, contents);
			now++;
			return store.save({ projectId, taskId: home.id, sourcePath, threadId: "main", workerId: null, ...changes });
		};
		const comment = (taskId: string, text: string) => runtime.board.recordFeedback({ taskId, text, images: 0, threadId: "main", requestId: text });
		// The first edition predates settlement so Studio has a boundary to show.
		const settledClock = now;
		now -= 86400000;
		const guide = await save("seasonal-guide.html", guidePage(spec.name, 1, spec.guide), {
			title: spec.guide, note: "A document carried forward by successive tasks.", tags: ["web", "guide"],
		});
		now = settledClock + 1;
		await store.update(projectId, guide.id, { living: true });
		const feedback = await comment(home.id, `Could the meeting point be easier to find?\n\n(artifact ${guide.id}~1, seasonal-guide.html)`);
		const oldClock = now;
		now = Date.now() - 86400000;
		const followUp = await addTask(spec.later, "done", home.id);
		const review = await addTask(spec.review, "review", followUp.id);
		for (let version = 2; version <= (projects.length === 0 ? 28 : 4); version++) {
			await save("seasonal-guide.html", guidePage(spec.name, version, spec.guide), {
				continueArtifactId: guide.id, taskId: version < 5 ? followUp.id : review.id,
			});
		}
		await runtime.board.setFeedback({ taskId: home.id, feedbackId: feedback.id, state: "addressed", note: "The guide now names the meeting point beside the east gate." });
		await comment(review.id, `Keep the meeting point at the top of the next edition.\n\n(artifact ${guide.id})`);
		await runtime.harness.commit(async tx => {
			const board = await tx.doc(BoardDoc, runtime.conversation.id);
			board.decisions.unshift(
				{ id: "D2", text: "Put the meeting point above the route list.", why: "Help visitors find it quickly.", taskId: followUp.id, at: new Date(now).toISOString() },
				{ id: "D1", text: "Keep the guide to a single page.", why: null, taskId: home.id, at: new Date(oldClock).toISOString() },
			);
			board.counters.decision = 2;
		}, BACKGROUND_CONTEXT);
		for (const state of ["before", "after"] as const) await save(`wayfinding--web-phone-light-${state}.png`, wayfinding(state === "after"), {
			title: `${spec.pair} ${state}`,
			tags: ["web", "phone", "light", state], taskId: followUp.id,
		});
		await save("print-notes.md", "# Print notes\n\nUse large type and leave room for the route changes.\n", { title: spec.notes });
		if (projects.length === 0) {
			const pinned = await save("field-checklist.html", guidePage(spec.name, 1, "Field checklist"), { title: "Field checklist", taskId: followUp.id });
			await store.update(projectId, pinned.id, { pinned: true });
			await save("volunteer-brief.html", guidePage(spec.name, 1, "Volunteer brief"), { title: "Volunteer brief", taskId: review.id });
			await save("courtyard--web-desktop.png", wayfinding(true), { title: "Courtyard sign", taskId: null });
		}
		if (spec.archived) {
			const archived = await client.request({ type: "projects.configure", projectId, archived: true });
			if (archived.type !== "projects.configure") throw errorOf(archived);
		}
		projects.push({ id: projectId, name: spec.name, artifactId: guide.id, homeTaskId: home.id, laterTaskIds: [followUp.id, review.id] });
		now = oldClock;
	}
	now = Date.now();
	const library = await client.request({ type: "artifacts.library" });
	if (library.type !== "artifacts.library" || library.artifacts.length !== 15 || !library.tasks.some(task => task.archived)) {
		throw new Error("Synthetic artifact library did not seed as expected.");
	}
	await Bun.write(output, JSON.stringify({ url: setup.server.url, projectId: projects[0]!.id, projects, pid: process.pid, root: setup.root }, null, 2));
	console.log(`Synthetic artifact library ready: ${output}`);
	await new Promise<void>(resolve => {
		process.once("SIGINT", resolve);
		process.once("SIGTERM", resolve);
	});
} finally {
	client?.close();
	await setup.cleanup();
}

function guidePage(name: string, version: number, title: string): string {
	return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>
<style>body{font:18px/1.6 system-ui;margin:3rem auto;max-width:38em;padding:0 1.5rem}h1{font-family:Georgia,serif}</style>
<p>${name} · Edition ${version}</p><h1>${title}</h1>
<h2>Meeting point</h2><p>${version === 1 ? "Meet by the gate." : "Meet beside the east gate, near the blue sign."}</p>
<h2>Routes</h2><ul><li>Courtyard loop · 15 minutes</li><li>Riverside walk · 35 minutes</li></ul></html>`;
}

/** Draw a synthetic wayfinding card as a native PNG, without browsers or external assets. */
function wayfinding(after: boolean): Buffer {
	const width = 360, height = 240, stride = width * 3 + 1;
	const pixels = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
		const paper = x > 30 && x < 330 && y > 36 && y < 204;
		const banner = paper && y < (after ? 111 : 68);
		const lines = x > 52 && x < (y < 152 ? 244 : 202) && (y >= 139 && y < 146 || y >= 162 && y < 169);
		pixels.set(banner ? (after ? [28, 105, 95] : [140, 153, 148]) : lines ? [89, 112, 109] : paper ? [250, 249, 237] : [218, 229, 220], y * stride + x * 3 + 1);
	}
	const chunk = (name: string, data: Buffer) => {
		const bytes = Buffer.alloc(data.length + 12);
		bytes.writeUInt32BE(data.length);
		bytes.write(name, 4);
		data.copy(bytes, 8);
		bytes.writeUInt32BE(Bun.hash.crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
		return bytes;
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width);
	header.writeUInt32BE(height, 4);
	header.set([8, 2], 8);
	return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
