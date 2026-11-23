import { afterEach, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { installPushEvents } from "../src/service-worker/push-events.ts";
import { clearPushSyncMarker, pushSyncMarkers, pushSyncScopes, setPushSyncNeeded } from "../src/lib/push-sync.ts";
const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
afterEach(() => {
	if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor);
	else Reflect.deleteProperty(globalThis, "indexedDB");
});
function worker(scope: string, windows: { url: string; visibilityState: DocumentVisibilityState }[] = []) {
	Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
	const listeners = new Map<string, (event: unknown) => void>();
	const messages: unknown[] = [],
		opened: string[] = [];
	const shown: { title: string; options: NotificationOptions & { renotify?: boolean } }[] = [];
	const matches: unknown[] = [];
	const api = {
		registration: { scope: "https://app.example.test" + scope, showNotification: async (title: string, options: NotificationOptions) => {
			shown.push({ title, options });
		} },
		location: { origin: "https://app.example.test" },
		clients: {
			matchAll: async (options: unknown) => { matches.push(options); return windows.map(window => ({ ...window, postMessage: (message: unknown) => messages.push(message) })); },
			openWindow: async (url: string) => opened.push(url),
		},
		addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
	};
	installPushEvents(api as unknown as ServiceWorkerGlobalScope);
	return { listeners, messages, opened, shown, matches, api };
}
test("push-only events have no fetch, cache, install, activate or claim behavior", () => {
	expect([...worker("/push/demo/").listeners.keys()]).toEqual(["push", "notificationclick", "pushsubscriptionchange"]);
});
for (const scope of ["/", "/push/demo/"])
	test(`subscription change in ${scope} only marks its scope; no subscribe, first key, socket or auth`, async () => {
		const fixture = worker(scope, [{ url: 'https://app.example.test/', visibilityState: 'hidden' }]);
		let completed: Promise<void> | undefined;
		fixture.listeners.get("pushsubscriptionchange")!({
			waitUntil: (promise: Promise<void>) => {
				completed = promise;
			},
			newSubscription: null,
		});
		await completed;
		expect(await pushSyncScopes()).toEqual([scope]);
		expect(fixture.messages).toEqual([{ type: "notifications-changed", scope }]);
	});
test("scoped notifications open the root app route, never a backend origin or scoped app", async () => {
	const fixture = worker("/push/demo/");
	fixture.api.clients.matchAll = async () => [];
	let completed: Promise<void> | undefined;
	const click = (url: string) => {
		fixture.listeners.get("notificationclick")!({
			notification: { data: { url }, close() {} },
			waitUntil: (promise: Promise<void>) => {
				completed = promise;
			},
		});
		return completed;
	};
	await click("/b/alpha/projects/synthetic");
	expect(fixture.opened).toEqual(["https://app.example.test/b/alpha/projects/synthetic"]);
	await click("https://other.example.test/phish");
	expect(fixture.opened).toHaveLength(1);
});

const pushFailure = (fixture: ReturnType<typeof worker>): Promise<void> | undefined => {
	let completed: Promise<void> | undefined;
	const payload = { kind: 'worker_failed', title: 'Recipe worker stopped', body: 'A worker did not report.', backendKey: 'lab',
		projectId: 'recipe', workerId: 'import', scheduleId: null, at: '2026-01-09T12:00:00Z', tag: 'worker:import' };
	fixture.listeners.get('push')!({ data: { text: () => JSON.stringify(payload) }, waitUntil: (promise: Promise<void>) => { completed = promise; } });
	return completed;
};

for (const scope of ['/', '/push/demo/']) {
	test(`a visible app window posts a failure silently in ${scope}`, async () => {
		const fixture = worker(scope, [{ url: 'https://app.example.test/b/lab/projects/recipe', visibilityState: 'visible' }]);
		await pushFailure(fixture);
		expect(fixture.matches).toEqual([{ type: 'window', includeUncontrolled: true }]);
		expect(fixture.shown).toEqual([expect.objectContaining({ options: expect.objectContaining({ silent: true, renotify: false, tag: 'worker:import' }) })]);
	});
}

test('a background tab or another origin leaves failure renotification unchanged', async () => {
	const fixture = worker('/push/demo/', [{ url: 'https://app.example.test/', visibilityState: 'hidden' },
		{ url: 'https://other.example.test/', visibilityState: 'visible' }]);
	await pushFailure(fixture);
	expect(fixture.shown[0]?.options.renotify).toBe(true);
	expect(fixture.shown[0]?.options.silent).toBeUndefined();
});

test("a completed page repair never clears a newer worker subscription change", async () => {
	worker("/");
	await setPushSyncNeeded("/", true);
	const markers = await pushSyncMarkers();
	await setPushSyncNeeded("/", true);
	await clearPushSyncMarker("/", markers["/"]!);
	expect(await pushSyncScopes()).toEqual(["/"]);
	const latest = await pushSyncMarkers();
	await clearPushSyncMarker("/", latest["/"]!);
	expect(await pushSyncScopes()).toEqual([]);
});
