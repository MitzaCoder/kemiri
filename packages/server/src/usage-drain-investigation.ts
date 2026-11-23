import { defineExtension, defineTool, type SetTimer } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardQuestionChoice, UsagePause } from "@kemiri/protocol";
import { errorMessage } from "./errors.ts";
import { readJsonFile } from "./fs-json.ts";
import { usageDrainFixedNotification, type NotificationEvent } from "./notifications.ts";
import type { DrainRunSpend } from "./request-log-store.ts";
import type { UsageDrainForecast } from "./usage-drain.ts";
import type { UsagePauseGate } from "./usage-pause.ts";
import { usagePauseConversation } from "./usage-pause-models.ts";

const MINUTE = 60_000;
const INVESTIGATION_MS = 5 * MINUTE;
const REPEAT_PAUSE_MS = 30 * MINUTE;
export const STOP_DRAIN_RUNS = "Stop them and use the usual model";
export const CONTINUE_DRAIN_RUNS = "Continue as it was";
export const KEEP_DRAIN_PAUSED = "Keep paused";
export const DRAIN_CHOICES: BoardQuestionChoice[] = [
	{ label: STOP_DRAIN_RUNS, effect: "Stops the active contributing runs on this computer whose model an agent chose outside its project’s worker list. Their coordinators are asked to restart them on a project worker model with the same brief. Then work resumes." },
	{ label: CONTINUE_DRAIN_RUNS, effect: "Resumes work as it was. This limit won’t be paused for fast drain again before it resets." },
	{ label: KEEP_DRAIN_PAUSED, effect: "New requests stay paused until the owner resumes them." },
];

export type Investigator = { projectId: string; threadId: string; conversationId: number; facts: string };
export type DrainQuestion = { projectId: string; questionId: string };
export type DrainStopTarget = { projectId: string; ownerThreadId: string; run: DrainRunSpend; provider: string; name: string };
export type DrainIncident = {
	id: string;
	providerLogin: string;
	label: string;
	forecast: UsageDrainForecast;
	spenders: DrainRunSpend[];
	deadline: number;
	since: string;
	phase: "looking" | "asking" | "fixed" | "keep";
	investigator?: Investigator;
	question?: DrainQuestion;
	note?: string;
	stopTargets?: DrainStopTarget[];
};
type DrainDocument = {
	version: 1;
	incidents?: DrainIncident[];
	investigatorResumedUntil?: Record<string, number>;
	continuedPeriods?: Record<string, number>;
};
type InvestigationOptions = {
	dataDir: string;
	gate: UsagePauseGate;
	now?: () => number;
	setTimer?: SetTimer;
	log: (message: string) => void;
	notify: (event: NotificationEvent) => void;
	chooseInvestigator: (incident: DrainIncident) => Promise<Investigator | undefined>;
	deliverFacts: (incident: DrainIncident, investigator: Investigator) => Promise<boolean>;
	investigatorAvailable: (investigator: Investigator) => Promise<boolean>;
	askOwner: (incident: DrainIncident) => Promise<DrainQuestion | undefined>;
	readAnswer: (question: DrainQuestion) => Promise<string | null>;
	withdrawQuestion: (incident: DrainIncident) => Promise<void>;
	chooseStopTargets: (incident: DrainIncident) => Promise<DrainStopTarget[]>;
	stopRuns: (incident: DrainIncident, targets: DrainStopTarget[], stillHeld: () => boolean) => Promise<void>;
};

function periodKey(login: string, limit: UsageDrainForecast["limit"]): string { return JSON.stringify([login, limit.id, limit.resetsAt]); }

export function drainPace(forecast: UsageDrainForecast): string {
	const { limit, usedPercent, rise, minutesMeasured, minutesLeft } = forecast;
	const rounded = (value: number | null) => value === null ? "?" : Number(value.toFixed(1));
	return `${limit.label}: ${rounded(usedPercent)}% used, up ${rounded(rise)} points in ${rounded(minutesMeasured)} minutes. About ${Math.round(minutesLeft ?? 0)} minutes left at this pace.`;
}

/** Backend-wide incident receipts. Deadlines and pending side effects survive reopening; exemptions are rebuilt. */
export class UsageDrainInvestigation {
	readonly #file: string;
	readonly #now: () => number;
	readonly #incidents = new Map<string, DrainIncident>();
	readonly #resumedUntil = new Map<string, number>();
	readonly #continued = new Map<string, number>();
	readonly #exemptions = new Map<string, () => void>();
	readonly #retryOwnerAt = new Map<string, number>();
	readonly #actions = new Map<string, Promise<void>>();
	#cancelTimer?: (() => void) | undefined;
	#started = false;
	#closed = false;

	private constructor(private readonly options: InvestigationOptions) {
		this.#now = options.now ?? Date.now;
		this.#file = join(options.dataDir, "usage-drain-investigation.json");
	}

	static async open(options: InvestigationOptions): Promise<UsageDrainInvestigation> {
		const service = new UsageDrainInvestigation(options);
		const saved = await readJsonFile(service.#file) as DrainDocument | undefined;
		if (!saved) return service;
		if (saved.version !== 1) throw new Error("Unsupported drain investigation document");
		for (const incident of saved.incidents ?? []) service.#incidents.set(incident.providerLogin, incident);
		for (const [login, until] of Object.entries(saved.investigatorResumedUntil ?? {})) if (until > service.#now()) service.#resumedUntil.set(login, until);
		for (const [limit, reset] of Object.entries(saved.continuedPeriods ?? {})) if (reset > service.#now()) service.#continued.set(limit, reset);
		return service;
	}

	start(): void {
		this.#started = true;
		for (const incident of this.#incidents.values()) this.#advance(incident);
		this.#armTimer();
	}

	drainState(pause: UsagePause): UsagePause["drain"] {
		const incident = this.#incidents.get(pause.providerLogin);
		if (pause.pausedBy !== "drain-monitor" || incident?.since !== pause.since) return undefined;
		if (incident.phase === "looking" || incident.phase === "fixed") return { status: "investigating" };
		if (incident.phase === "keep") return { status: "kept-paused" };
		return { status: "needs-choice", ...incident.question };
	}

	ignorePause(login: string, forecast: UsageDrainForecast): boolean {
		return (this.#continued.get(periodKey(login, forecast.limit)) ?? 0) > this.#now();
	}

	pause(login: string, label: string, forecast: UsageDrainForecast, spenders: DrainRunSpend[]): void {
		if (this.#closed || this.options.gate.isPaused(login) || this.ignorePause(login, forecast)) return;
		const now = this.#now();
		const incident: DrainIncident = {
			id: crypto.randomUUID(), providerLogin: login, label, forecast, spenders,
			deadline: now + INVESTIGATION_MS, since: new Date(now).toISOString(),
			phase: (this.#resumedUntil.get(login) ?? 0) > now ? "asking" : "looking",
		};
		this.#incidents.set(login, incident);
		this.#save();
		this.options.gate.pause(login, drainPace(forecast), { pausedBy: "drain-monitor", since: incident.since });
		this.#advance(incident);
		this.#armTimer();
	}

	/** Owner actions or a real exhausted limit may supersede a drain incident, but cannot inherit its exemption. */
	gateChanged(): void {
		if (!this.#started || this.#closed) return;
		for (const incident of this.#incidents.values()) if (!this.#held(incident)) this.#advance(incident);
	}

	credentialsChanged(login: string): void {
		this.#resumedUntil.delete(login);
		for (const key of this.#continued.keys()) if ((JSON.parse(key) as string[])[0] === login) this.#continued.delete(key);
		const incident = this.#incidents.get(login);
		if (incident) this.#retire(incident);
		else this.#save();
	}

	async coordinatorAction(projectId: string, conversationId: number, input: { incident: string; action: "resume" | "ask"; note?: string }): Promise<string> {
		const incident = [...this.#incidents.values()].find(candidate => candidate.id === input.incident);
		const investigator = incident?.investigator;
		if (!incident || !investigator || investigator.projectId !== projectId || investigator.conversationId !== conversationId || !this.#canInvestigate(incident)) {
			throw new Error("Only the assigned coordinator can act on this drain pause, once and within five minutes.");
		}
		const note = input.note?.trim();
		if (input.action === "resume" && (!note || /[\r\n\u2028\u2029]/u.test(input.note!))) throw new Error("Give one line describing what changed, or use ask.");
		if (input.action === "ask" || !await this.options.investigatorAvailable(investigator)) {
			if (this.#canInvestigate(incident)) this.#ask(incident);
			return "Left the subscription paused and handed the choice to the owner.";
		}
		if (!this.#canInvestigate(incident)) throw new Error("The owner has the choice now.");
		incident.phase = "fixed";
		incident.note = note!;
		this.#resumedUntil.set(incident.providerLogin, this.#now() + REPEAT_PAUSE_MS);
		this.#save();
		this.#finishFix(incident);
		return "Resumed the subscription. The owner gets one message with the note. Fast drain is still monitored.";
	}

	ownerAnswered(incidentId: string): void {
		const incident = [...this.#incidents.values()].find(candidate => candidate.id === incidentId);
		if (!incident || incident.phase !== "asking") return;
		// A reply may arrive while the question is being persisted. Run after that work, not in parallel with it.
		void (this.#actions.get(`${incident.id}:asking`) ?? Promise.resolve()).then(() => this.#advance(incident));
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#cancelTimer?.();
		for (const revoke of this.#exemptions.values()) revoke();
		await Promise.allSettled(this.#actions.values());
	}

	#held(incident: DrainIncident): boolean {
		return this.options.gate.state().some(pause => pause.providerLogin === incident.providerLogin && pause.pausedBy === "drain-monitor" && pause.since === incident.since);
	}

	#active(incident: DrainIncident): boolean {
		return !this.#closed && this.#incidents.get(incident.providerLogin) === incident;
	}

	#canInvestigate(incident: DrainIncident): boolean {
		return this.#active(incident) && incident.phase === "looking" && this.#now() < incident.deadline && this.#held(incident);
	}

	#advance(incident: DrainIncident): void {
		if (!this.#started || !this.#active(incident)) return;
		if (incident.phase === "fixed") { this.#finishFix(incident); return; }
		if (!this.#held(incident)) { this.#retire(incident); return; }
		if (incident.phase === "looking" && this.#now() >= incident.deadline) this.#ask(incident);
		if (incident.phase === "keep") return;
		const phase = incident.phase;
		const action = `${incident.id}:${phase}`;
		if (this.#actions.has(action) || (phase === "asking" && (this.#retryOwnerAt.get(incident.id) ?? 0) > this.#now())) return;
		this.#retryOwnerAt.delete(incident.id);
		const run = (phase === "looking" ? this.#investigate(incident) : this.#ownerChoice(incident)).catch(error => {
			if (phase === "asking" && this.#active(incident)) this.#retryOwnerAt.set(incident.id, this.#now() + 1_000);
			this.options.log(`drain investigation: ${errorMessage(error)}`);
			if (this.#canInvestigate(incident)) this.#ask(incident);
		}).finally(() => {
			this.#actions.delete(action);
			if (phase !== incident.phase) this.#advance(incident);
			this.#armTimer();
		});
		this.#actions.set(action, run);
	}

	async #investigate(incident: DrainIncident): Promise<void> {
		const investigator = incident.investigator ?? await this.options.chooseInvestigator(incident);
		if (!this.#canInvestigate(incident)) return;
		if (!investigator) { this.#ask(incident); return; }
		incident.investigator = investigator;
		this.#save();
		this.#exemptions.set(incident.id, this.options.gate.exempt(incident.providerLogin, usagePauseConversation(investigator.projectId, investigator.conversationId)));
		if (!await this.options.deliverFacts(incident, investigator) && this.#canInvestigate(incident)) this.#ask(incident);
	}

	#ask(incident: DrainIncident): void {
		incident.phase = "asking";
		this.#revoke(incident);
		this.#save();
		this.options.gate.refresh();
		this.#advance(incident);
		this.#armTimer();
	}

	async #ownerChoice(incident: DrainIncident): Promise<void> {
		const question = incident.question ?? await this.options.askOwner(incident);
		if (!this.#active(incident)) return;
		if (!question) {
			// With no project there is no board. Keep the hold and let the owner resume in Usage.
			incident.phase = "keep";
			this.#save();
			this.options.notify({ kind: "usage_drain_paused", title: `Paused: ${incident.label} usage was draining fast`,
				body: `${drainPace(incident.forecast)} Open Usage to resume.`, projectId: null, key: `usage-drain:${incident.id}`, tag: `usage-drain:${incident.providerLogin}` });
			this.options.gate.refresh();
			return;
		}
		if (!incident.question) {
			incident.question = question;
			this.#save();
			this.options.gate.refresh();
		}
		const answer = await this.options.readAnswer(question);
		if (!this.#active(incident) || !this.#held(incident)) return;
		if (answer === KEEP_DRAIN_PAUSED) {
			incident.phase = "keep";
			this.#save();
			this.options.gate.refresh();
		} else if (answer === CONTINUE_DRAIN_RUNS || answer === STOP_DRAIN_RUNS) {
			if (answer === STOP_DRAIN_RUNS) {
				if (!incident.stopTargets) {
					const targets = await this.options.chooseStopTargets(incident);
					if (!this.#active(incident) || !this.#held(incident)) return;
					incident.stopTargets = targets;
					this.#save();
				}
				await this.options.stopRuns(incident, incident.stopTargets, () => this.#active(incident) && this.#held(incident));
			}
			if (!this.#active(incident) || !this.#held(incident)) return;
			if (answer === CONTINUE_DRAIN_RUNS) {
				const { limit } = incident.forecast;
				const reset = Date.parse(limit.resetsAt ?? "");
				if (reset > this.#now()) this.#continued.set(periodKey(incident.providerLogin, limit), reset);
				this.#save(); // Keep the opt-out even if we crash between saving it and opening the gate.
			}
			this.options.gate.resume(incident.providerLogin, answer);
		}
	}

	#finishFix(incident: DrainIncident): void {
		this.#revoke(incident);
		// Remove from memory before the synchronous gate push re-enters this service. Keep the receipt on disk until notified.
		this.#incidents.delete(incident.providerLogin);
		if (this.#held(incident)) this.options.gate.resume(incident.providerLogin, incident.note!);
		this.options.notify(usageDrainFixedNotification({ providerLogin: incident.providerLogin, label: incident.label,
			projectId: incident.investigator?.projectId ?? null, incidentId: incident.id, note: incident.note! }));
		this.#save();
	}

	#retire(incident: DrainIncident): void {
		this.#revoke(incident);
		this.#incidents.delete(incident.providerLogin);
		this.#retryOwnerAt.delete(incident.id);
		this.#save();
		if (incident.phase === "asking") void (this.#actions.get(`${incident.id}:asking`) ?? Promise.resolve()).then(() => this.options.withdrawQuestion(incident))
			.catch(error => this.options.log(`drain question could not be withdrawn: ${errorMessage(error)}`));
	}

	#revoke(incident: DrainIncident): void {
		this.#exemptions.get(incident.id)?.();
		this.#exemptions.delete(incident.id);
	}

	#armTimer(): void {
		this.#cancelTimer?.();
		this.#cancelTimer = undefined;
		if (this.#closed || !this.#started) return;
		const now = this.#now();
		const deadline = Math.min(...this.#retryOwnerAt.values(),
			...[...this.#incidents.values()].filter(incident => incident.phase === "looking").map(incident => incident.deadline));
		if (!Number.isFinite(deadline)) return;
		const wake = () => { for (const incident of this.#incidents.values()) this.#advance(incident); this.#armTimer(); };
		if (this.options.setTimer) this.#cancelTimer = this.options.setTimer(wake, Math.max(0, deadline - now), { background: true });
		else {
			const timer = setTimeout(wake, Math.max(0, deadline - now));
			timer.unref?.();
			this.#cancelTimer = () => clearTimeout(timer);
		}
	}

	#save(): void {
		for (const map of [this.#resumedUntil, this.#continued]) for (const [key, time] of map) if (time <= this.#now()) map.delete(key);
		const document: DrainDocument = { version: 1, incidents: [...this.#incidents.values()],
			investigatorResumedUntil: Object.fromEntries(this.#resumedUntil), continuedPeriods: Object.fromEntries(this.#continued) };
		const temporary = `${this.#file}.${crypto.randomUUID()}.tmp`;
		try {
			const fd = openSync(temporary, "wx", 0o600);
			try { writeFileSync(fd, JSON.stringify(document)); fsyncSync(fd); }
			finally { closeSync(fd); }
			renameSync(temporary, this.#file);
		} finally { rmSync(temporary, { force: true }); }
	}
}

export function usagePauseTool(investigation: UsageDrainInvestigation, projectId: string, isCoordinator: (id: number) => boolean) {
	const tool = defineTool({
		name: "usage_pause", callers: ["model"], replay: "unsafe",
		description: "Respond to the active drain investigation assigned to this conversation. Resume once after a fix, or ask the owner and leave the subscription paused.",
		parameters: Type.Object({
			incident: Type.String({ description: "The incident code in the [usage] message." }),
			action: Type.Union([Type.Literal("resume"), Type.Literal("ask")]),
			note: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Required for resume: one line saying what changed." })),
		}),
		async execute(input, api) {
			try {
				if (!isCoordinator(api.conversationId)) throw new Error("Only a coordinator assigned the investigation can use this tool.");
				return { output: [{ type: "text", text: await investigation.coordinatorAction(projectId, api.conversationId, input) }] };
			} catch (error) { return { isError: true, output: [{ type: "text", text: errorMessage(error) }] }; }
		},
	});
	return defineExtension({ name: "usage-drain-investigator", tools: [tool] });
}
