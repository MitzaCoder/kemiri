import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BoardDoc } from "../src/board.ts";
import { OverviewRecordsDoc } from "../src/overview-records.ts";
import { bakeryOverviewFixture } from "../test/fixtures/coordinator-overview.ts";
import { createSetup } from "../test/support.ts";

// This demo always runs in new scratch directories with faux models. It cannot touch existing projects.
const webDir = process.argv[2];
const now = Date.now();
const setup = await createSetup({ now: () => now, terminals: false, ...(webDir ? { webDir } : {}) });
try {
 const project = await setup.server.manager.store.add(setup.projectDir);
 const { runtime } = await setup.server.manager.open(project.id);
 const bakery = await runtime.threads.create({ title: "Bakery", area: "Shop and labels", model: { provider: "faux", modelId: "faux-1" } }, "overview-demo");
 const { state, records } = bakeryOverviewFixture(now);
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
