import type { BoardQuestion, BoardTask, BoardTaskState, PartProofCount, PartsDigest } from '@kemiri/protocol';
import { partTone } from './task-parts.js';
import { taskStateLabel } from './task-state.js';
import { firstLine, isSettled, type TaskRow } from './tasks.js';

export function requestRows<T extends Pick<BoardTask, 'parent'>>(tasks: readonly T[], requestAttention: boolean): readonly T[] {
	return requestAttention ? tasks.filter(task => task.parent == null) : tasks;
}

export function requestAttentionLink(task: BoardTask, questions: readonly BoardQuestion[], taskHref: (id: string) => string) {
	const state = task.state;
	if (state?.group !== 'needs_you') return undefined;
	const taskId = state.fromPartId ?? task.id;
	const question = state.kind === 'answer_needed'
		? state.refs.map(ref => questions.find(row => row.id === ref && row.taskId === taskId)).find(Boolean)
		: undefined;
	const text = question ? firstLine(question.text, 160) : state.sentence?.text ?? taskStateLabel(task);
	const hash = state.kind === 'answer_needed' && state.refs.length ? `#task-question-${encodeURIComponent(question?.id ?? state.refs[0]!)}`
		: state.kind === 'steps_needed' ? '#task-steps'
		: state.kind === 'failed' ? '#task-needs-you' : '';
	return { taskId, href: `${taskHref(taskId)}${hash}`, text, questionId: question?.id, partTitle: state.fromPartTitle };
}

export function requestPartRows(rows: readonly TaskRow[]) {
	const rank = (row: TaskRow) => {
		const kind = row.task.state?.kind;
		return kind && ['working', 'needs-you'].includes(partTone(kind)) ? 0 : 1;
	};
	return rows.filter(row => row.task.status !== 'done')
		.sort((a, b) => rank(a) - rank(b) || a.task.order - b.task.order);
}

export function requestPartPage(task: BoardTask | undefined, request: BoardTask | undefined, digestSupported: boolean) {
	if (!digestSupported || task?.parent == null) return undefined;
	const requestId = task.requestId ?? request?.id ?? task.parent;
	const parts = request?.partsDigest?.parts;
	const index = parts?.findIndex(part => part.id === task.id) ?? -1;
	const part = index >= 0 ? parts?.[index] : undefined;
	const closedAt = isSettled(task.status) ? part?.closedAt ?? task.settledAt ?? undefined : undefined;
	const closedBy = isSettled(task.status) ? part?.closedBy ?? (task.updatedAt === closedAt ? task.updatedBy : undefined) : undefined;
	const closure = closedBy === 'user' ? 'Closed by you' : task.status === 'done' && closedBy === 'coordinator' ? 'Checked by the coordinator' : undefined;
	return {
		requestId, requestTitle: request?.title,
		position: part ? `Part ${index + 1} of ${parts!.length}` : 'Part',
		closure, closedAt,
	};
}

export function taskCanClose(partPage: ReturnType<typeof requestPartPage>): boolean {
	return partPage === undefined;
}

export const PARTS_CHECKLIST_PREVIEW = 5;

const labels: Record<BoardTaskState['kind'], string> = {
	done: 'Done', dropped: 'Dropped', working: 'Working', answer_needed: 'Answer needed', steps_needed: 'Your steps',
	failed: 'Failed', review: 'In review', clarifying: 'Clarifying', paused: 'Paused', blocked_by_task: 'Blocked', waiting_outside: 'Waiting', todo: 'To do',
};

export function partsChecklist(digest: PartsDigest, proof: readonly PartProofCount[]) {
	const byPart = new Map(proof.map(counts => [counts.partId, counts]));
	return digest.parts.map(part => {
		const counts = byPart.get(part.id);
		const proofLabels = (['images', 'videos', 'html', 'files'] as const).flatMap((kind, index) => {
			const count = counts?.[kind] ?? 0;
			const noun = ['image', 'video', 'page', 'file'][index];
			return count ? [`${count} ${noun}${count === 1 ? '' : 's'}`] : [];
		});
		const checks = `${part.checks.total} ${part.checks.total === 1 ? 'check' : 'checks'}`;
		return { ...part, summary: firstLine(part.summary, 200), label: labels[part.state], proofLabels, checks: part.checks.failed ? `${checks} · ${part.checks.failed} failed` : checks };
	});
}
