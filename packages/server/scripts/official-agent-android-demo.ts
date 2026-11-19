/**
 * Synthetic official-agent fixture for the Android settings proof. Run with Bun in an isolated environment
 * (`env -i`, temp HOME and XDG directories); it never reads installed accounts or starts the real agent.
 *
 * Antigravity runs behind the fake ACP agent fixture. The login state is `signed-out`, `subscription` (the marker
 * credential the subscription sign-in saves) or `api-key` (a fake key). Pass the first state as the argument; SIGUSR1
 * moves to the next one, so the app can be checked in all three without restarting the server.
 *
 * OFFICIAL_AGENT_DEMO_OUTPUT names the JSON file with the server URL, port and project ID.
 */
import { join } from "node:path";
import { createSetup, TestClient } from "../test/support.ts";

const STATES = ["signed-out", "subscription", "api-key"] as const;
type State = (typeof STATES)[number];
const PROVIDER = "antigravity";
const output = process.env.OFFICIAL_AGENT_DEMO_OUTPUT ?? "/tmp/official-agent-android-demo.json";
let state = (process.argv[2] ?? "subscription") as State;
if (!STATES.includes(state)) throw new Error(`State must be one of ${STATES.join(", ")}`);

const setup = await createSetup({ antigravityCommand: join(import.meta.dir, "../test/fixtures/fake-acp.ts"), terminals: false });

async function applyState(next: State): Promise<void> {
	state = next;
	if (next === "signed-out") return setup.credentials.delete(PROVIDER);
	await setup.credentials.modify(PROVIDER, async () => next === "api-key"
		? { type: "api_key", key: "synthetic-fixture-key" }
		: { type: "oauth", access: "", refresh: "", expires: Number.MAX_SAFE_INTEGER, nativeProfile: "synthetic-profile" });
}
await applyState(state);

const client = await TestClient.open(setup.server);
await client.hello();
const added = await client.request({ type: "projects.add", path: setup.projectDir });
if (added.type !== "projects.add") throw new Error(JSON.stringify(added));
const projectId = added.project.id;
const configured = await client.request({
	type: "projects.configure", projectId, name: "Paper garden",
	coordinatorModel: { provider: "faux", modelId: "faux-1" }, workerModels: [{ provider: PROVIDER, modelId: "gemini-3.8-flash" }],
});
if (configured.type !== "projects.configure") throw new Error(JSON.stringify(configured));
const url = new URL(setup.server.url);
await Bun.write(output, JSON.stringify({ url: setup.server.url, port: Number(url.port), projectId, pid: process.pid, root: setup.root }));
console.log(`Official-agent Android fixture ready (${state}): ${output}`);

let closing = false;
async function close() {
	if (closing) return;
	closing = true;
	client.close();
	await setup.cleanup();
	process.exit(0);
}
process.on("SIGUSR1", () => {
	const next = STATES[(STATES.indexOf(state) + 1) % STATES.length]!;
	void applyState(next).then(() => console.log(`State is now ${next}`));
});
process.on("SIGTERM", close);
process.on("SIGINT", close);
await new Promise(() => {});
