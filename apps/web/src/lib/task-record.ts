import { markdownText, type BoardDecision, type BoardFeedback, type BoardQuestion, type BoardTaskActivity, type BoardTaskSnapshot, type BoardTimelineEntry, type BoardTimelineFact, type BoardTimelineGroup, type WorkerSummary } from '@kemiri/protocol';
import { timelineDay, type TimelineOrder } from './task-timeline.js';

function answeredQuestionId(text: string | null): string | undefined {
	if (!text) return;
	// An explicit answer citation is provenance. An ordinary mention (e.g. “wait for Q3”) is not.
	const ids = new Set([...text.matchAll(/\bQ[1-9]\d*\b/gi)].map(match => match[0].toUpperCase()));
	const citation = /\b(?:answer|reply)\s+to\s+(?:question\s+)?[`*\[]*(Q[1-9]\d*)\b/i.exec(text)?.[1]?.toUpperCase();
	return ids.size === 1 ? citation : undefined;
}

export type DecidedRow = {
	id: string;
	at: string;
	decision?: BoardDecision;
	question?: BoardQuestion;
	why?: string;
};

/** The board has no decision→question field. Don't pair by wording, proximity, or a bare ID. */
export function taskDecided(taskId: string, decisions: readonly BoardDecision[], questions: readonly BoardQuestion[]): DecidedRow[] {
	const answered = questions.filter(q => q.taskId === taskId && q.kind !== 'warning' && q.status === 'answered');
	const answeredById = new Map(answered.map(q => [q.id, q]));
	const taskDecisions = decisions.filter(d => d.taskId === taskId);
	const citedBy = new Map<string, BoardDecision[]>();
	for (const decision of taskDecisions) {
		const inWhy = answeredQuestionId(decision.why), inText = answeredQuestionId(decision.text);
		if (inWhy && inText && inWhy !== inText) continue;
		const id = inWhy ?? inText;
		const question = id ? answeredById.get(id) : undefined;
		if (!question?.answeredAt || !(Date.parse(decision.at) >= Date.parse(question.answeredAt))) continue;
		const citing = citedBy.get(question.id) ?? [];
		citing.push(decision);
		citedBy.set(question.id, citing);
	}
	const paired = new Map<string, BoardQuestion>();
	for (const question of answered) {
		const citing = citedBy.get(question.id);
		if (citing?.length === 1) paired.set(citing[0].id, question);
	}
	const pairedIds = new Set([...paired.values()].map(q => q.id));
	return [
		...taskDecisions.map(decision => {
			const question = paired.get(decision.id);
			return { id: decision.id, at: decision.at, decision, question, why: question && answeredQuestionId(decision.why) ? undefined : decision.why ?? undefined };
		}),
		...answered.filter(q => !pairedIds.has(q.id)).map(question => ({ id: question.id, at: question.answeredAt ?? question.askedAt, question })),
	].sort((a, b) => b.at.localeCompare(a.at));
}

export type ActivityRow = {
	id: string;
	at?: string;
	label: string;
	detail?: string;
	workerId?: string;
	taskId?: string;
	fact?: BoardTimelineFact;
	snapshot?: BoardTaskSnapshot;
	now?: boolean;
};

type ActivitySources = {
	entries?: readonly BoardTimelineEntry[];
	groups?: readonly BoardTimelineGroup[];
	snapshots: readonly BoardTaskSnapshot[];
	questions: readonly BoardQuestion[];
	decisions: readonly DecidedRow[];
	feedback: readonly BoardFeedback[];
	workers: readonly { id: string; worker?: WorkerSummary }[];
	now?: { text: string; at: string; activity?: BoardTaskActivity };
	deliveryShown: boolean;
};

function questionRef(entry: BoardTimelineEntry): string | undefined {
	return entry.ref ?? /^(?:(?:Question|Warning) )?(Q[1-9]\d*)\b/i.exec(entry.label)?.[1]?.toUpperCase();
}

function workerId(entry: BoardTimelineEntry, fact?: BoardTimelineFact): string | undefined {
	return fact?.actor?.kind === 'worker' ? fact.actor.name : entry.ref ?? entry.by?.workerId ?? /^Worker (\S+) (?:started|resumed|reported|failed|stopped)\b/i.exec(entry.label)?.[1];
}

/** The exact milestone grammar in older servers, not arbitrary mentions of deploys or commits. */
export function isDeliveryMilestone(entry: BoardTimelineEntry, fact?: BoardTimelineFact): boolean {
	return entry.kind === 'milestone' && (fact?.source === 'change' || fact?.source === 'deploy' ||
		entry.ref?.startsWith('deploy:') === true || (/^\d+ changes? (?:landed on|removed from|reverted on) /.test(entry.label) && /^(?:Landed|Removed|Reverted) [a-f0-9]{12} /i.test(entry.detail ?? '')));
}

export function taskActivityRows(sources: ActivitySources): ActivityRow[] {
	const questionIds = new Set(sources.questions.filter(q => q.status === 'open' || (q.status === 'answered' && q.kind !== 'warning')).map(q => q.id));
	const decisionIds = new Set(sources.decisions.flatMap(row => row.decision ? [row.decision.id] : []));
	const feedbackIds = new Set(sources.feedback.map(f => f.id));
	const snapshotKeys = new Set(sources.snapshots.map(s => JSON.stringify([String(s.seq), s.at, s.label])));
	const rows: ActivityRow[] = sources.snapshots.map(snapshot => ({ id: `snapshot:${snapshot.seq}`, at: snapshot.at, label: activityStatus(snapshot.label), snapshot }));
	const representedWorkers = new Set<string>();
	const workerStarts = new Map<string, ActivityRow>();
	const seen = new Set<string>();
	const facts = sources.groups?.flatMap(group => group.entries);
	const entries: { entry: BoardTimelineEntry; fact?: BoardTimelineFact }[] = facts === undefined
		? (sources.entries ?? []).map(entry => ({ entry }))
		: facts.map(fact => ({ entry: fact, fact }));
	for (const { entry, fact } of entries) {
		if (entry.kind === 'question' && questionIds.has(questionRef(entry) ?? '')) continue;
		if (entry.kind === 'decision' && decisionIds.has(entry.ref ?? /^Decision (D\d+)\b/i.exec(entry.label)?.[1] ?? '')) continue;
		if (entry.kind === 'feedback' && feedbackIds.has(entry.ref ?? /^(?:Feedback )?(F\d+)\b/i.exec(entry.label)?.[1] ?? '')) continue;
		if (snapshotKeys.has(JSON.stringify([entry.ref, entry.at, entry.label]))) continue;
		if (sources.deliveryShown && isDeliveryMilestone(entry, fact)) continue;
		const id = fact?.id ?? JSON.stringify([entry.kind, entry.ref, entry.at, entry.label]);
		if (seen.has(id)) continue;
		seen.add(id);

		const worker = entry.kind === 'worker' ? workerId(entry, fact) : undefined;
		const at = fact?.endAt ?? entry.at;
		const row: ActivityRow = { id, at, label: entry.kind === 'status' ? activityStatus(entry.label) : entry.label, detail: entry.detail, workerId: worker, fact,
			taskId: entry.kind === 'link' ? entry.ref : undefined };
		if (worker) {
			representedWorkers.add(worker);
			// Legacy start and terminal events describe one episode. Keep restarts and other threads distinct.
			if (!fact) {
				const key = `${entry.by?.threadId ?? 'main'}:${worker}`;
				if (/\b(?:started|resumed)\b/i.test(entry.label)) workerStarts.set(key, row);
				else if (/\b(?:reported|stopped|failed)\b/i.test(entry.label)) {
					const start = workerStarts.get(key);
					if (start) { Object.assign(start, row, { id: start.id }); workerStarts.delete(key); continue; }
				}
			}
		}
		rows.push(row);
	}
	if (sources.now) {
		const { text, at, activity } = sources.now;
		const workerNow = activity?.kind === 'working' ? activity.actor?.id : undefined;
		const runningRow = workerNow && rows.find(row => row.fact?.actor?.id === workerNow && row.fact?.outcome === 'running');
		if (runningRow) Object.assign(runningRow, { label: text, at, now: true });
		else if (!rows.some(row => row.label === text || row.detail === text)) rows.push({ id: 'now', at, label: text, now: true });
	}
	for (const { id, worker } of sources.workers) {
		if (representedWorkers.has(id)) continue;
		const label = worker ? `${worker.title || id} · ${worker.status}` : `${id} · worker no longer available`;
		rows.push({ id: `worker:${id}`, at: worker?.updatedAt, label, workerId: id });
	}
	return rows;
}

export function activityDays(rows: readonly ActivityRow[], order: TimelineOrder, limit: number) {
	const sorted = [...rows].sort((a, b) => !a.at ? Number(Boolean(b.at)) : !b.at ? -1 : (order === 'newest' ? -1 : 1) * (Date.parse(a.at) - Date.parse(b.at)));
	const days = new Map<string, ActivityRow[]>();
	for (const row of sorted.slice(0, limit)) {
		const day = row.at ? timelineDay(row.at) : 'Date not recorded';
		const entries = days.get(day) ?? [];
		entries.push(row);
		days.set(day, entries);
	}
	return [...days].map(([day, entries]) => ({ day, entries }));
}

function activityStatus(label: string): string {
	return label.replaceAll(/\b(in_progress|todo)\b/g, status => status === 'todo' ? 'To do' : 'Working');
}

export function activityText(text: string): string {
	// Old deploy and worker log sentences can include abbreviated object IDs. Keep those out of Activity.
	return markdownText(text).replace(/\b(?=[a-f0-9]{7,64}\b)(?=[a-f0-9]*[0-9])(?=[a-f0-9]*[a-f])[a-f0-9]+\b/gi, 'the commit').replace(/\s+/g, ' ').trim();
}
