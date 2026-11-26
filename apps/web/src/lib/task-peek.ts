import { markdownText, type BoardQuestion, type BoardTask, type WorkerSummary } from '@kemiri/protocol';

/** Only direct parts that are working or need attention belong in the small preview. */
export function taskPeekParts(task: BoardTask, tasks: readonly BoardTask[], questions: readonly BoardQuestion[] = []) {
	const direct = tasks.filter(part => part.parent === task.id || task.subtasks?.includes(part.id));
	const listed = direct.filter(part => {
		if (part.state) return part.state.kind === 'working' || part.state.kind === 'clarifying' || part.state.group === 'needs_you';
		return ['in_progress', 'review', 'blocked'].includes(part.status) ||
			(!['done', 'dropped'].includes(part.status) && questions.some(question => question.taskId === part.id && question.status === 'open' && !question.postponed));
	}).sort((left, right) => left.order - right.order);
	const done = task.subtaskCount?.done ?? task.subtaskStates?.filter(kind => kind === 'done').length ?? direct.filter(part => (part.state?.kind ?? part.status) === 'done').length;
	return { listed, done };
}

/** Fold continuation lines into their bullet before limiting the report to three entries. */
export function taskPeekResults(source: string): string[] {
	const bullets: string[] = [];
	let paragraph = '';
	const flush = () => {
		const text = markdownText(paragraph).trim();
		if (text) bullets.push(text);
		paragraph = '';
	};
	for (const line of source.split(/\r?\n/)) {
		const bullet = /^\s*(?:[-*+] |\d+[.)] )\s*(.*)$/.exec(line);
		if (bullet) { flush(); paragraph = bullet[1]!; }
		else if (!line.trim()) flush();
		else paragraph += `${paragraph ? ' ' : ''}${line.trim()}`;
	}
	flush();
	return bullets.slice(0, 3);
}

/** Explicit assignment wins over the task's historical worker IDs; absent assignment is legacy. */
export function taskPeekWorkers(task: Pick<BoardTask, 'id' | 'workerIds'>, workers: readonly WorkerSummary[]): WorkerSummary[] {
	return workers.filter(worker => worker.taskId === task.id || (worker.taskId === undefined && task.workerIds.includes(worker.id)));
}
