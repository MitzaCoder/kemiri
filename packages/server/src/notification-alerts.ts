import type { NotificationAlert, NotificationAlertLevel, NotificationKind, NotificationRecentEntry, NotificationsRecentResponse, NotificationsResolvedEvent } from "@kemiri/protocol";
import { NotificationRecentEntrySchema } from "@kemiri/protocol";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "./errors.ts";
import { readJsonFile, writeJsonFile } from "./fs-json.ts";

const LEVEL_BY_KIND = {
	reply: "important",
	worker_report: "inbox",
	worker_failed: "important",
	schedule_done: "info",
	schedule_problem: "important",
	deploy_problem: "urgent",
	login_prompt: "urgent",
	compaction_failed: "info",
	maintenance_failed: "info",
	board_question: "urgent",
	thread_finished: "info",
	thread_failed: "important",
	coordinator_failed: "important",
	work_finished: "info",
	disk_low: "urgent",
	task_review: "important",
	task_steps: "important",
} satisfies Record<NotificationKind, NotificationAlertLevel>;

export function notificationAlertLevel(kind: NotificationKind, warning?: boolean): NotificationAlertLevel {
	return kind === "board_question" && warning ? "important" : LEVEL_BY_KIND[kind];
}

const MAX_ENTRIES = 200;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const NOTIFICATION_RECENT_FILE_NAME = "recent.json";

const RecentFileSchema = Type.Object({
	backendEpoch: Type.String({ minLength: 1 }),
	latestSeq: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	events: Type.Array(NotificationRecentEntrySchema),
});

type RecentPage = Pick<NotificationsRecentResponse, "backendEpoch" | "latestSeq" | "events">;
type Resolution = Extract<NotificationRecentEntry, { type: "resolved" }>;

function sequence(entry: NotificationRecentEntry): number {
	return entry.type === "alert" ? entry.alert.seq : entry.seq;
}

/** A per-backend stream, independent of push and its rollback-compatible state file. */
export class NotificationRecentStore {
	readonly #file: string;
	readonly #log: (message: string) => void;
	#backendEpoch: string = crypto.randomUUID();
	#latestSeq = 0;
	#events: NotificationRecentEntry[] = [];
	#writes = Promise.resolve();
	#writeQueued = false;

	constructor(dir: string, log: (message: string) => void) {
		this.#file = join(dir, NOTIFICATION_RECENT_FILE_NAME);
		this.#log = log;
	}

	async read(now: number): Promise<void> {
		try {
			const file = await readJsonFile(this.#file);
			if (file !== undefined) {
				if (!Value.Check(RecentFileSchema, file)) throw new Error("invalid alert history");
				this.#backendEpoch = file.backendEpoch;
				this.#latestSeq = file.latestSeq;
				this.#events = file.events;
				if (this.#prune(now)) this.#persist();
				return;
			}
		} catch (error) {
			this.#log(`notifications: could not read recent alerts: ${errorMessage(error)}`);
		}
		this.#persist();
		await this.flush();
	}

	append(alert: Omit<NotificationAlert, "seq" | "backendEpoch">, now: number): NotificationAlert {
		const recorded: NotificationAlert = { ...alert, seq: ++this.#latestSeq, backendEpoch: this.#backendEpoch };
		this.#events.push({ type: "alert", alert: recorded, resolved: false });
		this.#prune(now);
		this.#persist();
		return recorded;
	}

	/** Mark only retained open alerts. A later alert with the same tag starts unresolved. */
	resolve(matches: (alert: NotificationAlert) => boolean, now: number): NotificationsResolvedEvent | undefined {
		if (this.#prune(now)) this.#persist();
		const tags = new Set<string>();
		for (const [index, entry] of this.#events.entries()) {
			if (entry.type !== "alert" || entry.resolved || !matches(entry.alert)) continue;
			this.#events[index] = { ...entry, resolved: true };
			tags.add(entry.alert.tag);
		}
		if (tags.size > 0) this.#persist();
		// An older revision can be superseded without closing its newer, still-open replacement.
		for (const entry of this.#events) if (entry.type === "alert" && !entry.resolved) tags.delete(entry.alert.tag);
		if (tags.size === 0) return undefined;
		const cursor = { tags: [...tags], seq: ++this.#latestSeq, backendEpoch: this.#backendEpoch, at: new Date(now).toISOString() };
		const entry: Resolution = { type: "resolved", ...cursor };
		this.#events.push(entry);
		this.#prune(now);
		this.#persist();
		return { type: "notifications.resolved", ...cursor };
	}

	recent(after: number, now: number): RecentPage {
		if (this.#prune(now)) this.#persist();
		return { backendEpoch: this.#backendEpoch, latestSeq: this.#latestSeq, events: this.#events.filter((entry) => sequence(entry) > after) };
	}

	flush(): Promise<void> {
		return this.#writes;
	}

	#prune(now: number): boolean {
		const before = this.#events.length;
		this.#events = this.#events.filter((entry) => Date.parse(entry.type === "alert" ? entry.alert.at : entry.at) >= now - RETENTION_MS).slice(-MAX_ENTRIES);
		return this.#events.length !== before;
	}

	#persist(): void {
		if (this.#writeQueued) return;
		this.#writeQueued = true;
		this.#writes = this.#writes.then(async () => {
			this.#writeQueued = false;
			await writeJsonFile(this.#file, { backendEpoch: this.#backendEpoch, latestSeq: this.#latestSeq, events: this.#events });
		}).catch((error: unknown) => this.#log(`notifications: could not save recent alerts: ${errorMessage(error)}`));
	}
}
