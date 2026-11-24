import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { SetTimer } from "@earendil-works/pi-durable";
import { expect, test } from "bun:test";
import { isProviderNetworkError, projectHasProviderOutage } from "../src/provider-outage.ts";
import { createSetup, entryText, TestClient, ViewClient } from "./support.ts";

const NETWORK_ERROR = "Connection error.: getaddrinfo ENOTFOUND api.example.test";
const outageResponse = () => fauxAssistantMessage([], { stopReason: "error", errorMessage: NETWORK_ERROR });

test("separates transport failures from provider errors", () => {
	for (const error of [NETWORK_ERROR, "getaddrinfo EAI_AGAIN api.example.test", "connect ECONNREFUSED 192.0.2.1", "read ECONNRESET", "ETIMEDOUT", "TypeError: fetch failed", "The network is offline", "Unable to connect. Is the computer able to access the url?"]) {
		expect(isProviderNetworkError(error)).toBe(true);
	}
	for (const error of [undefined, "", "500: network error", "HTTP 503: fetch failed", "429 rate limit", "ETIMEDOUT status code: 504", "401 invalid credentials", "model offline-mode not found", "invalid token with label ENOTFOUND", "Connection error.: certificate has expired", '{"error":"fetch failed"}']) {
		expect(isProviderNetworkError(error)).toBe(false);
	}
});

function testClock() {
	let now = Date.parse("2026-01-01T00:00:00Z");
	const timers = new Map<() => void, number>();
	const setTimer: SetTimer = (fire, delay) => {
		timers.set(fire, now + delay);
		return () => { timers.delete(fire); };
	};
	return { now: () => now, setTimer, advance(ms: number) {
		now += ms;
		for (const [fire, at] of [...timers]) if (at <= now) { timers.delete(fire); fire(); }
	} };
}

async function project(client: TestClient, path: string, provider = "faux") {
	await client.hello();
	const added = await client.request({ type: "projects.add", path });
	if (added.type !== "projects.add") throw Error(JSON.stringify(added));
	const projectId = added.project.id;
	expect((await client.request({ type: "projects.configure", projectId,
		coordinatorModel: { provider, modelId: "faux-1" }, workerModels: [{ provider: "demo-provider", modelId: "faux-1" }],
	})).type).toBe("projects.configure");
	return projectId;
}

const provider = () => fauxProvider({ provider: "demo-provider", models: [{ id: "faux-1" }] });
const live = (view: { docs: Record<string, unknown> }) => view.docs["pi.live"] as {
	run?: unknown; providerOutage?: { tries: number; retryAt: number }; runFailure?: { reason?: string };
} | undefined;

test("holds the same run across restart, recovers without error entries, and expires distinctly", async () => {
	const clock = testClock();
	const upstream = provider();
	const setup = await createSetup({ ...clock, configureModels: models => models.setProvider({ ...upstream.provider, name: "Demo Provider" }) });
	let client = await TestClient.open(setup.server);
	try {
		const projectId = await project(client, setup.projectDir, "demo-provider");
		let watch = new ViewClient(client);
		await watch.start(projectId);
		upstream.setResponses([outageResponse(), outageResponse(), fauxAssistantMessage("The provider came back."), outageResponse(), outageResponse()]);
		const send = (requestId: string) => client.request({ type: "conversation.submit", projectId, requestId, content: requestId });
		await send("first question");
		const first = await watch.waitForView(view => live(view)?.providerOutage?.tries === 1);
		expect(first.docs["pi.live"]).toMatchObject({ providerOutage: { label: "Demo Provider", retryAt: clock.now() + 5000, error: NETWORK_ERROR } });
		expect(first.entries.filter(entry => entry.kind === "pi.assistant")).toHaveLength(0);
		expect(await projectHasProviderOutage((await setup.server.manager.open(projectId)).runtime.harness)).toBe(true);
		client.close();
		await setup.restart();
		client = await TestClient.open(setup.server);
		await client.hello();
		watch = new ViewClient(client);
		await watch.start(projectId);
		await watch.waitForView(view => live(view)?.providerOutage?.tries === 1);
		expect(upstream.state.callCount).toBe(1);
		clock.advance(5_000);
		await watch.waitForView(view => live(view)?.providerOutage?.tries === 2);
		clock.advance(10_000);
		const recovered = await watch.waitForView(view => view.entries.some(entry => entryText(entry).includes("The provider came back.")) && !live(view)?.run);
		expect(live(recovered)?.providerOutage).toBeUndefined();
		expect(live(recovered)?.runFailure).toBeUndefined();
		expect(recovered.entries.filter(entry => entry.kind === "pi.assistant")).toHaveLength(1);

		await send("another question");
		await watch.waitForView(view => live(view)?.providerOutage?.tries === 1);
		clock.advance(3 * 60 * 60_000);
		const failed = await watch.waitForView(view => live(view)?.runFailure?.reason === "network_error");
		expect(live(failed)?.run).toBeUndefined();
		expect(failed.docs["pi.live"]).toMatchObject({ runFailure: { detail: NETWORK_ERROR, providerLabel: "Demo Provider" } });
		expect(await projectHasProviderOutage((await setup.server.manager.open(projectId)).runtime.harness)).toBe(false);
		expect(upstream.state.callCount).toBe(5);
	} finally { client.close(); }
}, 20_000);

test("keeps a worker running during the outage and accepts Stop without failing its task", async () => {
	const clock = testClock();
	const upstream = provider();
	const setup = await createSetup({ ...clock, configureModels: models => models.setProvider(upstream.provider) });
	const client = await TestClient.open(setup.server);
	try {
		const projectId = await project(client, setup.projectDir);
		setup.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("worker_spawn", { id: "waiting-worker", task: "Review the kite design" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Worker started."),
		]);
		upstream.setResponses([outageResponse()]);
		const coordinator = new ViewClient(client);
		await coordinator.start(projectId);
		await client.request({ type: "conversation.submit", projectId, requestId: "start-worker", content: "Delegate the review." });
		await coordinator.waitForView(view => view.entries.some(entry => entryText(entry).includes("Worker started.")));
		const spawned = await client.request({ type: "workers.list", projectId });
		expect(spawned).toMatchObject({ type: "workers.list", workers: [{ id: "waiting-worker", status: "running" }] });
		const worker = new ViewClient(client);
		await worker.start(projectId, { workerId: "waiting-worker" });
		await worker.waitForView(view => live(view)?.providerOutage?.tries === 1);
		const { runtime } = await setup.server.manager.open(projectId);
		expect(await projectHasProviderOutage(runtime.harness)).toBe(true);
		setup.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("worker_stop", { id: "waiting-worker" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Worker stopped."),
		]);
		await client.request({ type: "conversation.submit", projectId, requestId: "stop-worker", content: "Stop the review." });
		await coordinator.waitForView(view => view.entries.some(entry => entryText(entry).includes("Worker stopped.")));
		expect(await client.request({ type: "workers.list", projectId })).toMatchObject({ workers: [{ id: "waiting-worker", status: "stopped" }] });
		await worker.waitForView(view => !live(view)?.run && !live(view)?.providerOutage);
		expect(await projectHasProviderOutage(runtime.harness)).toBe(false);
		clock.advance(30_000);
		expect(upstream.state.callCount).toBe(1);
	} finally { client.close(); }
}, 20_000);
