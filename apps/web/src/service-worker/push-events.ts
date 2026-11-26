/// <reference lib="webworker" />
import { markdownText } from "@kemiri/protocol";
import { isNotificationFailure, notificationUrl, parseNotificationPayload } from "@kemiri/client";
import type { NotificationPayload } from "@kemiri/protocol";
import { closeExactBrowserCards, parseBrowserClear } from "../lib/close-browser-notifications.ts";
import { PUSH_CHANGED_MESSAGE, setPushSyncNeeded } from "../lib/push-sync.ts";

/** Shared presentation and root-app click routing; never authentication or subscription creation. */
export function installPushEvents(worker: ServiceWorkerGlobalScope): void {
	const ICON = "/icons/icon-192.png";
	const BADGE = "/icons/badge-96.png";
	worker.addEventListener("push", (event) => {
		event.waitUntil(
			(async () => {
				const text = event.data?.text();
				const input = text ? safeJson(text) : null;
				if (input && typeof input === "object" && "kind" in input && input.kind === "resolved") {
					const clear = parseBrowserClear(input);
					if (clear) closeExactBrowserCards(await worker.registration.getNotifications(), clear);
					return;
				}
				const payload = text === undefined ? null : parseNotificationPayload(text);
				const url = payload === null ? "/" : notificationUrl(payload);
				const title = payload?.title ?? "Kemiri";
				// Scoped push workers do not control the root app. They still see its same-origin windows.
				const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true }).catch(() => []);
				const silent = windows.some(client => client.visibilityState === "visible" && new URL(client.url).origin === worker.location.origin);
				const options: NotificationOptions & { renotify?: boolean; timestamp?: number } = {
					body:
						payload?.kind === "board_question"
							? markdownText(payload.body)
							: (payload?.body ?? "Open the app to see what happened."),
					icon: ICON,
					badge: BADGE,
					tag: payload?.tag ?? "aiki",
					// An open window keeps the OS copy quiet, even when a failure replaces an earlier notice.
					...(silent ? { silent: true } : {}),
					renotify: !silent && payload !== null && payload.kind !== "resolved" && isNotificationFailure(payload.kind),
					data: { url, payload },
				};
				const at = payload === null ? Number.NaN : Date.parse(payload.at);
				if (Number.isFinite(at)) options.timestamp = at;
				await worker.registration.showNotification(title, options);
			})(),
		);
	});

	function safeJson(text: string): unknown {
		try { return JSON.parse(text); } catch { return null; }
	}

	worker.addEventListener("notificationclick", (event) => {
		event.notification.close();
		const data = event.notification.data as { url?: unknown } | null;
		const path = typeof data?.url === "string" && data.url.length > 0 ? data.url : "/";
		event.waitUntil(openApp(path));
	});

	/**
	 * Open the app at `path`: an open window is focused and sent there, otherwise a new one opens. Same origin only; a
	 * notification's data comes from a backend, so it never decides which site this app navigates to.
	 */
	async function openApp(path: string): Promise<void> {
		const target = new URL(path, worker.location.origin);
		if (target.origin !== worker.location.origin) return;
		const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
		for (const client of windows) {
			if (new URL(client.url).origin !== worker.location.origin) continue;
			try {
				await client.focus();
			} catch {
				// A browser that will not focus a window still gets the route; the click must open it either way.
			}
			try {
				await client.navigate(target.href);
			} catch {
				// A window already navigating; focus is still what the click asked for.
			}
			return;
		}
		await worker.clients.openWindow(target.href);
	}

	worker.addEventListener("pushsubscriptionchange", (event) => {
		event.waitUntil(
			(async () => {
				const scope = new URL(worker.registration.scope).pathname;
				await setPushSyncNeeded(scope, true);
				const windows = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
				for (const client of windows) client.postMessage({ type: PUSH_CHANGED_MESSAGE, scope });
			})(),
		);
	});
}
