import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BoardDoc } from "../src/board.ts";
import { OverviewRecordsDoc } from "../src/overview-records.ts";
import { bakeryOverviewFixture, withBakeryLiveWork } from "../test/fixtures/coordinator-overview.ts";
import { HARNESS_FEATURES } from "@kemiri/protocol";
import { createSetup } from "../test/support.ts";

// This demo always runs in new scratch directories with faux models. It cannot touch existing projects.
const webDir = process.argv.slice(2).find(arg => !arg.startsWith("--"));
const features = process.argv.includes("--without-overview") ? HARNESS_FEATURES.filter(feature => feature !== "coordinator-overview") : undefined;
const now = Date.now();
const setup = await createSetup({ now: () => now, terminals: false, ...(features ? { features } : {}), ...(webDir ? { webDir } : {}) });
try {
 const project = await setup.server.manager.store.add(setup.projectDir);
 await setup.server.manager.store.update(project.id, { name: "Lumen Bakery", coordinatorModel: { provider: "faux", modelId: "faux-1" } });
 const { runtime } = await setup.server.manager.open(project.id);
 const bakery = await runtime.threads.create({ title: "Bakery", area: "Shop and labels", model: { provider: "faux", modelId: "faux-1" } }, "overview-demo");
 const { state, records, design, at } = bakeryOverviewFixture(now, true);
 withBakeryLiveWork(state, design.id, at(.38), bakery.conversationId);
 for (const task of state.tasks) if (task.ownerThreadId === "bakery") task.ownerThreadId = bakery.id;
 for (const question of state.questions) if (question.threadId === "bakery") question.threadId = bakery.id;
 await runtime.harness.commit(async tx => {
  const board = await tx.doc(BoardDoc, runtime.conversation.id);
  const table = await tx.doc(OverviewRecordsDoc, runtime.conversation.id);
  Object.assign(board, state);
  Object.assign(table, records);
 }, BACKGROUND_CONTEXT);
 console.log(JSON.stringify({ port: setup.server.port, projectId: project.id, coordinatorId: bakery.id }));
 await new Promise<void>(resolve => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
 });
} finally { await setup.cleanup(); }
