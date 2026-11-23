import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsagePause, UsageWindow } from "@kemiri/protocol";
import { UsagePauseSchema } from "@kemiri/protocol";
import { Value } from "typebox/value";
import type { SetTimer } from "@earendil-works/pi-durable";
import { readJsonFile } from "./fs-json.ts";

export const USAGE_RESET_MARGIN_MS = 15_000;
const MAX_TIMER_MS = 2_147_483_647;

type PauseMeta = { pausedBy: UsagePause["pausedBy"]; until?: number };
type LimitWindow = Pick<UsageWindow, "label" | "usedPercent" | "resetsAt">;
type ResumeOverride = { providerLogin: string; until?: string };
type PauseDocument = { version: 1; pauses?: UsagePause[]; resumedLimits?: ResumeOverride[] };
type UsagePauseOptions = {
	dataDir: string;
	now?: () => number;
	setTimer?: SetTimer;
	onChange?: (pauses: UsagePause[]) => void;
	onLimitReached?: (pause: UsagePause) => void;
	onResume?: (providerLogin: string) => void;
	log?: (message: string) => void;
};

function active(until: string | undefined, now: number): boolean {
	return until === undefined || Date.parse(until) > now;
}

/** One per backend, shared by every project's runtime. `providerLogin` names the active credential slot. */
export class UsagePauseGate {
	readonly #options: UsagePauseOptions;
	readonly #file: string;
	readonly #now: () => number;
	readonly #waiters = new Map<string, Set<() => void>>();
	readonly #exemptions = new Map<string, Map<string, symbol>>();
	#pauses = new Map<string, UsagePause>();
	#resumedLimits = new Map<string, ResumeOverride>();
	#cancelTimer: (() => void) | undefined;
	#closed = false;
	#stoppingBackground = false;

	private constructor(options: UsagePauseOptions) {
		this.#options = options;
		this.#file = join(options.dataDir, "usage-pause.json");
		this.#now = options.now ?? Date.now;
	}

	static async open(options: UsagePauseOptions): Promise<UsagePauseGate> {
		const gate = new UsagePauseGate(options);
		const saved = (await readJsonFile(gate.#file)) as PauseDocument | undefined;
		if (saved !== undefined) {
			if (saved?.version !== 1) throw new Error("Unsupported usage pause document");
			for (const pause of saved.pauses ?? []) {
				if (!Value.Check(UsagePauseSchema, pause)) throw new Error("Invalid saved usage pause");
				if (active(pause.until, gate.#now())) gate.#pauses.set(pause.providerLogin, pause);
			}
			for (const override of saved.resumedLimits ?? []) {
				if (typeof override?.providerLogin === "string" && active(override.until, gate.#now())) gate.#resumedLimits.set(override.providerLogin, override);
			}
		}
		gate.#armReset();
		return gate;
	}

	state(): UsagePause[] {
		const now = this.#now();
		return [...this.#pauses.values()].filter(pause => active(pause.until, now)).map(pause => ({ ...pause }));
	}

	isPaused(providerLogin: string): boolean {
		const pause = this.#pauses.get(providerLogin);
		return pause !== undefined && active(pause.until, this.#now());
	}

	pause(providerLogin: string, reason: string, meta: PauseMeta): void {
		if (this.#closed) return;
		const now = this.#now();
		if (meta.until !== undefined && meta.until <= now) return;
		const previous = this.isPaused(providerLogin) ? this.#pauses.get(providerLogin) : undefined;
		const priority = { owner: 2, "limit-reached": 1, "drain-monitor": 0 };
		if (previous && priority[previous.pausedBy] > priority[meta.pausedBy]) return;
		const sameSource = previous?.pausedBy === meta.pausedBy;
		const until = meta.until === undefined ? undefined : new Date(meta.until).toISOString();
		// Another exhausted window can extend the hold. An unknown reset does not overwrite one we already know.
		if (sameSource && meta.pausedBy === "limit-reached" && (previous.until ? !until || until <= previous.until : !until)) return;
		const pause: UsagePause = {
			providerLogin, reason, pausedBy: meta.pausedBy,
			since: sameSource ? previous.since : new Date(now).toISOString(),
			...(until === undefined ? {} : { until }),
		};
		if (!Value.Check(UsagePauseSchema, pause)) throw new Error("Invalid usage pause");
		const pauses = new Map(this.#pauses).set(providerLogin, pause);
		this.#save(pauses);
		this.#changed();
		if (meta.pausedBy === "limit-reached" && !sameSource) this.#options.onLimitReached?.(pause);
	}

	holdUntil(providerLogin: string, until: number, reason: string, meta: Omit<PauseMeta, "until">): void {
		this.pause(providerLogin, reason, { ...meta, until });
	}

	resume(providerLogin: string, note: string): void {
		const pause = this.#pauses.get(providerLogin);
		if (!pause || !this.isPaused(providerLogin) || this.#closed) return;
		const pauses = new Map(this.#pauses);
		pauses.delete(providerLogin);
		const overrides = new Map(this.#resumedLimits);
		if (pause.pausedBy === "limit-reached") {
			overrides.set(providerLogin, { providerLogin, ...(pause.until === undefined ? {} : { until: pause.until }) });
		}
		this.#save(pauses, overrides);
		this.#options.onResume?.(providerLogin);
		this.#options.log?.(`usage pause: resumed ${providerLogin}: ${note}`);
		this.#changed();
	}

	/** A new or removed credential must not inherit the previous credential's pause or override. */
	credentialsChanged(providerLogin: string): void {
		if (this.#closed) return;
		this.#exemptions.delete(providerLogin);
		if (!this.#pauses.has(providerLogin) && !this.#resumedLimits.has(providerLogin)) return;
		const pauses = new Map(this.#pauses);
		const overrides = new Map(this.#resumedLimits);
		pauses.delete(providerLogin);
		overrides.delete(providerLogin);
		this.#save(pauses, overrides);
		this.#changed();
	}

	/** A specific conversation can pass the drain monitor only, not an owner's pause or a provider's limit. */
	exempt(providerLogin: string, conversation: string): () => void {
		const exemptions = this.#exemptions.get(providerLogin) ?? new Map<string, symbol>();
		this.#exemptions.set(providerLogin, exemptions);
		const exemption = Symbol();
		exemptions.set(conversation, exemption);
		this.#wake(providerLogin);
		return () => {
			if (exemptions.get(conversation) !== exemption) return;
			exemptions.delete(conversation);
			if (exemptions.size === 0 && this.#exemptions.get(providerLogin) === exemptions) this.#exemptions.delete(providerLogin);
		};
	}

	observeReading(providerLogin: string, windows: readonly LimitWindow[]): void {
		if (this.#closed) return;
		const now = this.#now();
		const exhausted = windows.flatMap(window => {
			if (window.usedPercent === null || window.usedPercent < 100) return [];
			const reset = window.resetsAt === null ? undefined : Date.parse(window.resetsAt);
			if (reset !== undefined && reset <= now) return [];
			return [{ label: window.label, reset }];
		});
		const override = this.#resumedLimits.get(providerLogin);
		if (override && active(override.until, now)) {
			if (exhausted.length && exhausted.every(window => window.reset === undefined ||
				(override.until !== undefined && window.reset + USAGE_RESET_MARGIN_MS <= Date.parse(override.until)))) return;
			// Recovering from an unknown reset, or a different window reached its limit.
			if ((override.until === undefined && windows.some(window => window.usedPercent !== null)) || exhausted.length > 0) {
				const overrides = new Map(this.#resumedLimits);
				overrides.delete(providerLogin);
				this.#save(this.#pauses, overrides);
			}
		}
		if (exhausted.length === 0) return;
		const latest = exhausted.sort((a, b) => (b.reset ?? 0) - (a.reset ?? 0))[0]!;
		this.limitReached(providerLogin, latest.label, latest.reset);
	}

	limitReached(providerLogin: string, label: string, reset?: number): void {
		this.pause(providerLogin, `${label} reached${reset === undefined ? `. Reset time isn't known.` : "."}`, {
			pausedBy: "limit-reached",
			...(reset === undefined ? {} : { until: reset + USAGE_RESET_MARGIN_MS }),
		});
	}

	canSend(providerLogin: string, conversation?: string): boolean {
		return !this.isPaused(providerLogin) || (this.#pauses.get(providerLogin)?.pausedBy === "drain-monitor" &&
			conversation !== undefined && this.#exemptions.get(providerLogin)?.has(conversation) === true);
	}

	async wait(providerLogin: string, signal?: AbortSignal, conversation?: string): Promise<void> {
		for (;;) {
			signal?.throwIfAborted();
			if (this.#closed || (this.#stoppingBackground && signal === undefined)) throw new Error("Usage pause gate closed");
			if (this.canSend(providerLogin, conversation)) return;
			await new Promise<void>(resolve => {
				const waiters = this.#waiters.get(providerLogin) ?? new Set();
				this.#waiters.set(providerLogin, waiters);
				const wake = () => {
					waiters.delete(wake);
					if (waiters.size === 0) this.#waiters.delete(providerLogin);
					signal?.removeEventListener("abort", wake);
					resolve();
				};
				waiters.add(wake);
				signal?.addEventListener("abort", wake, { once: true });
			});
		}
	}

	/** Background memory has no task signal. Unblock its shutdown without completing durable conversation waits. */
	stopBackgroundWaits(): void {
		this.#stoppingBackground = true;
		for (const providerLogin of this.#waiters.keys()) this.#wake(providerLogin);
	}

	close(): void {
		this.#closed = true;
		this.#cancelTimer?.();
		for (const providerLogin of this.#waiters.keys()) this.#wake(providerLogin);
	}

	#wake(providerLogin: string): void {
		for (const wake of this.#waiters.get(providerLogin) ?? []) wake();
	}

	#changed(): void {
		this.#armReset();
		for (const providerLogin of this.#waiters.keys()) this.#wake(providerLogin);
		this.#options.onChange?.(this.state());
	}

	#armReset(): void {
		this.#cancelTimer?.();
		this.#cancelTimer = undefined;
		const now = this.#now();
		const earliest = Math.min(...[...this.#pauses.values()].flatMap(pause => pause.until ? [Date.parse(pause.until)] : []));
		if (!Number.isFinite(earliest) || this.#closed) return;
		const fire = () => {
			// Expiration is intrinsic to the stored timestamp, including after a crash before this timer fired.
			for (const [login, pause] of this.#pauses) if (!active(pause.until, this.#now())) this.#pauses.delete(login);
			this.#changed();
		};
		const delay = Math.min(MAX_TIMER_MS, Math.max(0, earliest - now));
		if (this.#options.setTimer !== undefined) this.#cancelTimer = this.#options.setTimer(fire, delay, { background: true });
		else {
			const timer = setTimeout(fire, delay);
			timer.unref?.();
			this.#cancelTimer = () => clearTimeout(timer);
		}
	}

	#save(pauses: Map<string, UsagePause>, overrides = this.#resumedLimits): void {
		const temporary = `${this.#file}.${crypto.randomUUID()}.tmp`;
		const liveOverrides = new Map([...overrides].filter(([, override]) => active(override.until, this.#now())));
		const document: PauseDocument = { version: 1, pauses: [...pauses.values()], resumedLimits: [...liveOverrides.values()] };
		try {
			const fd = openSync(temporary, "wx", 0o600);
			try { writeFileSync(fd, JSON.stringify(document)); fsyncSync(fd); }
			finally { closeSync(fd); }
			renameSync(temporary, this.#file);
		} finally { rmSync(temporary, { force: true }); }
		this.#pauses = pauses;
		this.#resumedLimits = liveOverrides;
	}
}
