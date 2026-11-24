import type { BoardTask, BoardTaskInput } from '@kemiri/protocol';
import { isSettled, taskStatusWords } from './tasks.js';

export type OpenPartsChoice = 'close' | 'follow_up';
export type TaskSaveOptions = { taskId?: string; expectedRevision?: number; note?: string; ownerThreadId?: string | null; openParts?: OpenPartsChoice };
export function openDirectParts(tasks: readonly BoardTask[], taskId: string): BoardTask[] {
	return tasks.filter(task => task.parent === taskId && !isSettled(task.status));
}
export function closePartsQuestion(taskId: string, parts: readonly Pick<BoardTask, 'id' | 'status'>[]): string {
	return `${taskId} has ${parts.length} open ${parts.length === 1 ? 'part' : 'parts'}: ${parts.map(part => `${part.id} (${part.status === 'todo' ? 'to do' : part.status === 'review' ? 'in review' : part.status === 'in_progress' ? 'in progress' : taskStatusWords(part.status).toLowerCase()})`).join(', ')}. What should happen to them?`;
}
export function openPartsError(error: unknown): error is { code: 'open_parts'; message: string } {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'open_parts';
}

/** All owner save paths share the choice, including the server's stale-board refusal. */
export async function saveWithCloseChoice(input: BoardTaskInput, options: TaskSaveOptions, context: {
	enabled: boolean;
	tasks: () => readonly BoardTask[];
	refresh: () => Promise<void>;
	ask: (text: string) => Promise<OpenPartsChoice | undefined>;
	save: (input: BoardTaskInput, options: TaskSaveOptions) => Promise<BoardTask>;
}): Promise<{ kind: 'saved'; task: BoardTask; closedParts?: boolean } | { kind: 'cancelled' }> {
	const closing = context.enabled && (input.status === 'done' || input.status === 'dropped') && options.taskId;
	async function choose(fallback?: string): Promise<boolean> {
		const parts = openDirectParts(context.tasks(), options.taskId!);
		if (!parts.length && !fallback) return true;
		const choice = await context.ask(parts.length ? closePartsQuestion(options.taskId!, parts) : fallback!);
		if (!choice) return false;
		options = { ...options, openParts: choice };
		return true;
	}
	if (closing && !options.openParts && !await choose()) return { kind: 'cancelled' };
	let task: BoardTask;
	try { task = await context.save(input, options); }
	catch (error) {
		if (!closing || options.openParts || !openPartsError(error)) throw error;
		await context.refresh();
		if (!await choose(error.message)) return { kind: 'cancelled' };
		options = { ...options, expectedRevision: context.tasks().find(task => task.id === options.taskId)?.revision ?? options.expectedRevision };
		task = await context.save(input, options);
	}
	return { kind: 'saved', task, ...(options.openParts ? { closedParts: true } : {}) };
}
