import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRef, ThinkingLevel, WorkerModel } from "@kemiri/protocol";
import type { ProjectStore } from "./projects.ts";
import type { DrainRunSpend } from "./request-log-store.ts";
import type { ProjectManager, ProjectRuntime } from "./runtime.ts";
import type { ThreadRecord } from "./threads.ts";
import { drainPace, type DrainIncident, type DrainQuestion, type DrainStopTarget, type Investigator } from "./usage-drain-investigation.ts";
import { projectWorkerModel, type WorkerRecord } from "./workers.ts";

const usd = (value: number) => `$${value.toFixed(2)}`;
function rankTotals<T>(rows: DrainRunSpend[], attribute: (row: DrainRunSpend) => T | undefined) {
	const totals = new Map<T, { apiValue: number; requests: number }>();
	for (const row of rows) {
		const key = attribute(row);
		if (key === undefined) continue;
		const total = totals.get(key) ?? { apiValue: 0, requests: 0 };
		total.apiValue += row.apiValue;
		total.requests += row.requests;
		totals.set(key, total);
	}
	return [...totals].sort((a, b) => b[1].apiValue - a[1].apiValue || b[1].requests - a[1].requests);
}

function modelWithThinking(model: ModelRef, thinkingLevel: ThinkingLevel | null | undefined): string {
	return `${model.provider}/${model.modelId} · thinking ${thinkingLevel ?? "default"}`;
}

function resetSummary(incident: DrainIncident, includeTime = false): string {
	const minutes = Math.round(incident.forecast.minutesToReset ?? 0);
	const timeLeft = [Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)} h` : "", minutes % 60 ? `${minutes % 60} min` : ""].filter(Boolean).join(" ") || "less than a minute";
	if (!includeTime || !incident.forecast.limit.resetsAt) return `It resets in about ${timeLeft}.`;
	const reset = new Intl.DateTimeFormat("en", { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" })
		.format(new Date(incident.forecast.limit.resetsAt));
	return `It resets at ${reset} (in about ${timeLeft}).`;
}

/** Pure message formatting. Only the local lines cross the project boundary; the other rows become one total. */
export function drainFacts(incident: DrainIncident, projectId: string, localLines: string[], workerModels: readonly WorkerModel[]): string {
	const otherValue = incident.spenders.filter(row => row.projectId !== projectId).reduce((sum, row) => sum + row.apiValue, 0);
	return [
		`[usage] Paused: ${incident.label} was draining fast. New requests on this login and computer wait until resumed.`,
		`${drainPace(incident.forecast)} ${resetSummary(incident, true)}`,
		`Spent most in this project in the last 10 minutes (API prices):\n${localLines.join("\n")}`,
		`Other projects on this computer: ${usd(otherValue)} total.`,
		`This project's worker models: ${workerModels.map(model => modelWithThinking(model, model.thinkingLevel)).join(", ") || "none configured"}.`,
		"You may stop runs the owner did not ask to have on that model, restart them on a project worker model with the same brief, or stop a run repeating the same step or failing request.",
		"If the owner wanted the use, work could be lost, a coordinator model would need changing, a reset is needed, or nothing changed, leave the pause on and ask. Ask too if unsure.",
		`You get one attempt and five minutes from the pause. After a fix call usage_pause with incident ${incident.id}, action resume and a one-line note saying what changed. To hand over, call usage_pause with that incident and action ask. A second pause within 30 minutes goes straight to the owner.`,
	].join("\n\n");
}

/** Project-side actions use the runtime services, the same board as the app, and durable input request IDs. */
export class UsageDrainProjects {
	constructor(private readonly store: ProjectStore, private readonly manager: () => ProjectManager) {}

	async #open(projectId: string): Promise<ProjectRuntime> {
		return (await this.manager().open(projectId)).runtime;
	}

	async #projects(incident: DrainIncident) {
		const projects = (await this.store.list()).filter(project => !project.archived);
		const ranks = new Map(rankTotals(incident.spenders, row => row.projectId).map(([id], rank) => [id, rank]));
		return projects.sort((a, b) => (ranks.get(a.id) ?? ranks.size) - (ranks.get(b.id) ?? ranks.size));
	}

	async chooseInvestigator(incident: DrainIncident): Promise<Investigator | undefined> {
		const runtimes = new Map<string, ProjectRuntime>();
		const threads = new Map<string, Record<string, ThreadRecord>>();
		const projects = await this.#projects(incident);
		const activeProjects = new Set(projects.map(project => project.id));
		const spenders = incident.spenders.filter(row => activeProjects.has(row.projectId) && row.threadId && row.conversationId > 0);
		const biggestRun = rankTotals(incident.spenders, row => JSON.stringify([row.projectId, row.conversationId]))[0]?.[0];
		for (const projectId of new Set(spenders.map(row => row.projectId))) {
			const runtime = await this.#open(projectId);
			runtimes.set(projectId, runtime);
			threads.set(projectId, (await runtime.threads.state()).threads);
		}
		const largest = rankTotals(spenders, row => {
			const records = threads.get(row.projectId)!;
			const record = records[row.threadId!];
			const owner = row.kind === "thread" && record?.kind === "job" ? record.parentThreadId ?? "main" : row.threadId!;
			return JSON.stringify([row.projectId, owner]);
		})[0];
		if (!largest) return undefined;
		const [projectId, threadId] = JSON.parse(largest[0]) as [string, string];
		const runtime = runtimes.get(projectId)!;
		const place = runtime.coordinators.placeOfThread(threadId);
		if (!place || biggestRun === JSON.stringify([projectId, place.conversationId])) return undefined;
		const record = threads.get(projectId)?.[threadId];
		if (threadId !== "main" && (!record || record.archived || record.held)) return undefined;
		const localSpend = incident.spenders.filter(row => row.projectId === projectId).slice(0, 10);
		const lines = await Promise.all(localSpend.map(async row => {
			const run = await this.#run(runtime, row);
			const name = row.kind === "worker" ? `worker ${row.workerId}` : row.kind === "main" ? "General" : run && "title" in run ? run.title : row.threadId ?? "Other work";
			const thinking = run?.model.modelId === row.model ? run.thinkingLevel ?? "default" : "unknown";
			const named = run?.model.modelId === row.model ? ("modelNamedByAgent" in run && run.modelNamedByAgent === true) : null;
			const origin = named === null ? "model choice not recorded" : named ? "an agent named this model" : "not agent-named";
			return `- ${JSON.stringify(name)} · ${row.model} · thinking ${thinking} · ${origin} · ${usd(row.apiValue)} · ${row.requests} requests`;
		}));
		return { projectId, threadId, conversationId: place.conversationId, facts: drainFacts(incident, projectId, lines, runtime.project.workerModels) };
	}

	async investigatorAvailable(investigator: Investigator): Promise<boolean> {
		const runtime = await this.#open(investigator.projectId);
		if (runtime.project.archived || runtime.coordinators.placeOfThread(investigator.threadId)?.conversationId !== investigator.conversationId) return false;
		if (investigator.threadId === "main") return true;
		const record = await runtime.threads.record(investigator.threadId);
		return record !== undefined && !record.archived && !record.held;
	}

	async deliverFacts(incident: DrainIncident, investigator: Investigator): Promise<boolean> {
		const runtime = await this.#open(investigator.projectId);
		return runtime.threads.deliverUsageMessage(investigator.threadId, investigator.facts, `usage-drain-facts:${incident.id}`, "refuse");
	}

	async askOwner(incident: DrainIncident): Promise<DrainQuestion | undefined> {
		const projectId = incident.question?.projectId ?? (await this.#projects(incident))[0]?.id;
		if (!projectId) return undefined;
		const runtime = await this.#open(projectId);
		const runs = incident.spenders.filter(row => row.projectId === projectId);
		const leader = runs[0];
		const run = leader ? await this.#run(runtime, leader) : undefined;
		const name = leader?.workerId ?? (run && "title" in run ? run.title : leader?.threadId === "main" ? "General" : leader?.threadId);
		const spend = runs.reduce((sum, row) => sum + row.apiValue, 0);
		const who = leader
			? `${runtime.project.name} spent most on this computer (${usd(spend)} at API prices). ${name ? `${name} on ` : `Its top recorded model was `}${leader.model}${name ? " led that use" : ""}.`
			: "No project could be matched to the recent requests.";
		const question = await runtime.board.askUsageDrain(incident.id, [
			`How should ${incident.label} work resume on this computer?`,
			`${drainPace(incident.forecast)} ${resetSummary(incident)}`,
			`${who} New requests on this login are waiting.`,
		].join("\n"));
		return { projectId, questionId: question.id };
	}

	async readAnswer(question: DrainQuestion): Promise<string | null> {
		return (await (await this.#open(question.projectId)).board.state()).questions.find(row => row.id === question.questionId)?.answer ?? null;
	}

	async withdrawQuestion(incident: DrainIncident): Promise<void> {
		const projectId = incident.question?.projectId ?? (await this.#projects(incident))[0]?.id;
		if (projectId) await (await this.#open(projectId)).board.withdrawUsageDrain(incident.id);
	}

	async chooseStopTargets(incident: DrainIncident): Promise<DrainStopTarget[]> {
		const projectIds = new Set((await this.#projects(incident)).map(project => project.id));
		const runtimeByProject = new Map<string, ProjectRuntime>();
		const targets = new Map<string, DrainStopTarget>();
		for (const row of incident.spenders) {
			if (!row.threadId || !projectIds.has(row.projectId) || (row.kind !== "worker" && row.kind !== "thread")) continue;
			const key = JSON.stringify([row.projectId, row.conversationId]);
			if (targets.has(key)) continue;
			const runtime = runtimeByProject.get(row.projectId) ?? await this.#open(row.projectId);
			runtimeByProject.set(row.projectId, runtime);
			const run = await this.#run(runtime, row);
			if (!run || !("modelNamedByAgent" in run) || run.modelNamedByAgent !== true || run.status !== "running" ||
				run.model.modelId !== row.model || run.model.provider !== incident.providerLogin || projectWorkerModel(runtime.project.workerModels, run.model)) continue;
			if ("kind" in run && (run.kind !== "job" || run.archived)) continue;
			targets.set(key, { projectId: row.projectId, ownerThreadId: "parentThreadId" in run ? run.parentThreadId ?? "main" : row.threadId!,
				run: row, provider: run.model.provider, name: run.id });
		}
		const jobs = new Set([...targets.values()].filter(target => target.run.kind === "thread").map(target => JSON.stringify([target.projectId, target.run.threadId])));
		// Stopping a job also stops its workers. Only its parent should get a restart request, not the stopped job.
		return [...targets.values()].filter(target => !jobs.has(JSON.stringify([target.projectId, target.ownerThreadId])));
	}

	async stopRuns(incident: DrainIncident, targets: DrainStopTarget[], stillHeld: () => boolean): Promise<void> {
		for (const target of targets) {
			if (!stillHeld()) return;
			const runtime = await this.#open(target.projectId);
			const record = await this.#run(runtime, target.run);
			if (!stillHeld()) return;
			if (!record || !("modelNamedByAgent" in record) || !record.modelNamedByAgent || record.model.provider !== target.provider ||
				record.model.modelId !== target.run.model || projectWorkerModel(runtime.project.workerModels, record.model)) continue;
			if ("kind" in record && (record.kind !== "job" || record.archived)) continue;
			if (record.status === "running") {
				if ("kind" in record) await runtime.threads.stopThread(record.id);
				else await runtime.workers.stopForUsageDrain(target.ownerThreadId, record.id, record.conversationId);
			} else if (record.status !== "stopped") continue;
			const content = `[usage] The owner chose to stop ${"kind" in record ? "job" : "worker"} ${JSON.stringify(target.name)} on ${target.run.model} after a fast subscription drain. Restart it on a project worker model with the same brief. Do not restart it if it already finished.`;
			await runtime.threads.deliverUsageMessage(target.ownerThreadId, content, `usage-drain-stop:${incident.id}:${target.run.conversationId}`, "queue");
		}
	}

	async #run(runtime: ProjectRuntime, row: DrainRunSpend): Promise<WorkerRecord | ThreadRecord | { model: ModelRef; thinkingLevel: ThinkingLevel | null } | undefined> {
		if (row.kind === "main") {
			const { model, thinkingLevel } = runtime.project.coordinator;
			return model ? { model, thinkingLevel } : undefined;
		}
		if (!row.threadId) return undefined;
		if (row.kind === "thread") {
			const thread = await runtime.threads.record(row.threadId);
			return thread?.conversationId === row.conversationId ? thread : undefined;
		}
		if (row.kind !== "worker" || !row.workerId) return undefined;
		const place = runtime.coordinators.placeOfThread(row.threadId);
		if (!place) return undefined;
		const worker = (await runtime.workers.state(BACKGROUND_CONTEXT, place.conversationId)).workers[row.workerId];
		return worker?.conversationId === row.conversationId ? worker : undefined;
	}
}
