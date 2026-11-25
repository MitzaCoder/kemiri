import type { BoardTask } from '@kemiri/protocol';

/** The optional state is consumed only after the hello capability gate. */
export function taskStateSupported(features: readonly string[] | undefined): boolean {
	return features?.includes('task-state') ?? false;
}

export function taskWithStateSupport(task: BoardTask, enabled: boolean, partsEnabled = false): BoardTask {
	return { ...task, state: enabled ? task.state : undefined, subtaskStates: partsEnabled ? task.subtaskStates : undefined };
}

export function taskStateLabel(task: Pick<BoardTask, 'state' | 'waiting'>, tasks: readonly Pick<BoardTask, 'id' | 'title'>[] = []): string | undefined {
	switch (task.state?.kind) {
		case 'failed': return 'Failed';
		case 'answer_needed': return 'Answer needed';
		case 'steps_needed': return 'Your steps';
		case 'review': return 'Ready for review';
		case 'working': return 'Working';
		case 'clarifying': return task.state.checkingFeedbackId ? 'Checking your note' : 'Clarifying';
		case 'paused': return 'Paused';
		case 'blocked_by_task': return `Blocked by ${task.state.refs.map(id => {
			const title = tasks.find(task => task.id === id)?.title;
			return title ? `${id} ${title.length > 48 ? `${title.slice(0, 47)}…` : title}` : id;
		}).join(', ')}`;
		case 'waiting_outside': {
			const note = task.waiting?.note;
			if (!note && task.state.sentence) return task.state.sentence.text;
			return note ? /^waiting for\b/i.test(note) ? note : `Waiting for ${note}` : 'Waiting';
		}
		case 'todo': return 'To do';
		case 'done': return 'Done';
		case 'dropped': return 'Dropped';
	}
}

export function taskStateStatus(task: Pick<BoardTask, 'state' | 'status'>): BoardTask['status'] {
	switch (task.state?.kind) {
		case 'failed': return 'blocked';
		case 'answer_needed': case 'steps_needed': return 'review';
		case 'working': case 'clarifying': return 'in_progress';
		case 'paused': case 'blocked_by_task': case 'waiting_outside': return 'waiting';
		default: return task.state?.kind ?? task.status;
	}
}

const KIND_ORDER: Record<string, number> = { failed: 0, answer_needed: 1, steps_needed: 2, review: 3, working: 0, clarifying: 0, paused: 1 };
/** Derived groups share the same sorting on the list and board. */
export function compareTaskStates(left: BoardTask, right: BoardTask): number {
	if (!left.state || !right.state) return left.order - right.order;
	const group = left.state.group;
	if (group === 'todo') return left.order - right.order;
	if (group === 'closed') return Date.parse(right.settledAt ?? right.state.since) - Date.parse(left.settledAt ?? left.state.since);
	const kind = group === 'needs_you' || group === 'in_progress' ? (KIND_ORDER[left.state.kind] ?? 0) - (KIND_ORDER[right.state.kind] ?? 0) : 0;
	return kind || Date.parse(left.state.since) - Date.parse(right.state.since) || left.order - right.order;
}

/** Status keys remain unchanged for Android's shared graph vectors. */
export function graphTaskState(task: BoardTask): string {
	return task.state?.kind ?? task.status;
}
