import type { BoardQuestion, BoardTask, WorkerSummary } from '@kemiri/protocol';

export type WorkerMotion = 'working' | 'waiting' | 'sleeping' | 'failed' | 'done';
type MotionQuestion = Pick<BoardQuestion, 'taskId' | 'status' | 'waitingOn' | 'kind' | 'blocksWork'>;

/** Status wins over asks. Only an idle worker can wait for an answer. Task visibility is separate. */
export function workerMotion(
	worker: Pick<WorkerSummary, 'status'>,
	task: Pick<BoardTask, 'id' | 'status'> | null | undefined,
	questions: readonly MotionQuestion[],
): WorkerMotion {
	if (worker.status === 'running') return 'working';
	if (worker.status === 'failed') return 'failed';
	if (worker.status === 'done' || worker.status === 'stopped') return 'done';
	const openTask = task && !['done', 'dropped'].includes(task.status);
	if (openTask && (task.status === 'review' || questions.some(question => question.taskId === task.id
		&& question.status === 'open' && question.waitingOn !== 'agent'
		&& (question.blocksWork ?? question.kind !== 'warning')))) return 'waiting';
	return 'sleeping';
}

export type WorkerMotionCandidate = { id: string; state: WorkerMotion; inView: boolean };
export type WorkerMotionAllowance = { looping: boolean; still: boolean; delayMs: number };
export const maxLoopingWorkers = 12;

/** Stable phase in master loop milliseconds, independent of camera, status and board order. */
export function workerMotionDelay(id: string): number {
	let hash = 2166136261;
	for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	return -((hash >>> 0) % 6000);
}

/** Camera code supplies intersection, including the mascot's bounds, not just its centre. */
export function workerMotionBudget(
	workers: readonly WorkerMotionCandidate[], zoom: number, reducedMotion = false,
): Map<string, WorkerMotionAllowance> {
	const stillCamera = reducedMotion || !Number.isFinite(zoom) || zoom < .5;
	const looping = new Set(workers.filter(worker => !stillCamera && worker.inView
		&& ['working', 'waiting', 'sleeping'].includes(worker.state))
		.map(worker => worker.id).sort().slice(0, maxLoopingWorkers));
	return new Map(workers.map(worker => [worker.id, {
		looping: looping.has(worker.id), still: stillCamera || !worker.inView, delayMs: workerMotionDelay(worker.id),
	}]));
}
