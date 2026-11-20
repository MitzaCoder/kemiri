import type { BoardTask } from '@kemiri/protocol';
import { isSettled, isWarning, taskStatusWords } from '#lib/tasks.js';
import { waitingSummary } from '#lib/task-waiting.js';
import type { taskNeedsYou } from '#lib/task-details.js';

export type RouteDoor = 'you' | 'got' | 'ahead';
type Attention = ReturnType<typeof taskNeedsYou>;
export const ROUTE_DOORS_MIN_WIDTH = 1000;

export function routeAttention(task: BoardTask, needsYou: Attention | undefined) {
	const questions = needsYou?.ownerQuestions.filter(question => !isWarning(question)).length ?? 0;
	const warnings = (needsYou?.ownerQuestions.length ?? 0) - questions;
	const review = task.status === 'review';
	const blocked = task.status === 'blocked';
	const steps = Boolean(needsYou?.stepsMarkdown);
	const count = questions + warnings + Number(review) + Number(steps) + Number(blocked);
	const label = questions ? questions === 1 ? 'One answer needed' : `${questions} answers needed`
		: warnings ? warnings === 1 ? 'One heads-up' : `${warnings} heads-ups`
		: blocked ? 'Blocked' : steps ? 'Your steps to do' : review ? 'Ready for you to check' : undefined;
	return { questions, warnings, review, blocked, steps, count, label };
}

export function defaultRouteDoor(attentionCount: number): RouteDoor {
	return attentionCount > 0 ? 'you' : 'got';
}

export type RouteStop = {
	id: string;
	label: string;
	detail: string;
	state: 'done' | 'now' | 'waits' | 'ahead';
	at?: string;
	taskId?: string;
};

export function routeParts(task: BoardTask, tasks: readonly BoardTask[]): BoardTask[] {
	return tasks.filter(part => part.parent === task.id).sort((left, right) => left.order - right.order);
}

export function routeStops(task: BoardTask, parts: readonly BoardTask[], attention: ReturnType<typeof routeAttention>, liveSince?: string): RouteStop[] {
	const settled = isSettled(task.status);
	const plan = task.live?.plan;
	const planNow = plan?.findIndex(step => step.status === 'doing');
	const waitsAtReview = attention.review && attention.count === 1;
	const partsNow = parts.find(part => part.status === 'in_progress')?.id;
	const steps: RouteStop[] = plan?.length ? plan.map((step, index) => ({
		id: `plan-${index}`, label: step.text, detail: step.text,
		state: step.status === 'done' ? 'done' : index === planNow && !settled ? 'now' : 'ahead',
		at: index === planNow && !settled ? liveSince : undefined,
	})) : parts.map(part => ({
		id: `part-${part.id}`, label: part.title, detail: taskStatusWords(part.status), taskId: part.id,
		state: part.status === 'done' ? 'done' : !settled && partsNow === part.id ? 'now' : 'ahead',
		at: part.settledAt ?? part.state?.since,
	}));

	// A plan step has no question ID. Keep the interchange separate rather than guessing which step it blocks.
	const nowIndex = steps.findIndex(stop => stop.state === 'now');
	if (nowIndex < 0 && !settled && !waitsAtReview) {
		const firstAhead = steps.findIndex(stop => stop.state === 'ahead');
		steps.splice(firstAhead < 0 ? steps.length : firstAhead, 0, {
			id: 'current', label: taskStatusWords(task.status),
			detail: task.status === 'waiting' && task.waiting ? waitingSummary(task) : taskStatusWords(task.status),
			state: 'now', at: liveSince ?? task.state?.since,
		});
	}
	if (attention.count > Number(attention.review)) {
		const current = steps.findIndex(stop => stop.state === 'now');
		steps.splice(current < 0 ? steps.length : current + 1, 0, {
			id: 'owner', label: 'Your stop', detail: attention.label ?? 'Something needs your attention.', state: 'waits',
		});
	}
	return [
		{ id: 'asked', label: 'Asked', detail: 'The task was opened.', at: task.createdAt, state: 'done' },
		...steps,
		{ id: 'review', label: 'You check', detail: 'Check the work before closing the task.', state: waitsAtReview ? 'waits' : task.status === 'done' ? 'done' : 'ahead' },
		{ id: 'end', label: task.status === 'dropped' ? 'Dropped' : 'Done', detail: settled ? 'The task is closed.' : 'The task closes after the work is checked.', at: task.settledAt ?? undefined, state: settled ? 'done' : 'ahead' },
	];
}
