import { getContext, setContext } from 'svelte';
import type { BoardQuestion, BoardTask, ThreadSummary } from '@kemiri/protocol';
import { scopedQuestions, scopedTasks, taskCoordinator } from './coordinators.js';

export interface CoordinatorTaskView {
	roster: readonly ThreadSummary[];
	threads: readonly ThreadSummary[];
	coordinatorId?: string;
	hidden: ReadonlySet<string>;
}
const TASK_VIEW = Symbol('coordinator task view');
export function provideCoordinatorTaskView(read: () => CoordinatorTaskView | undefined) { setContext(TASK_VIEW, read); }
export function useCoordinatorTaskView() { return getContext<(() => CoordinatorTaskView | undefined) | undefined>(TASK_VIEW); }
export function hasMultipleTaskCoordinators(view: CoordinatorTaskView): boolean {
	// Archived coordinators stay available for owner lookup but aren't in the switcher roster.
	return view.roster.filter(thread => !thread.archived).length > 1;
}
export function taskCoordinatorInAllView(task: BoardTask, view: CoordinatorTaskView | undefined): ThreadSummary | undefined {
	if (!view || view.coordinatorId !== undefined || !hasMultipleTaskCoordinators(view)) return undefined;
	return view.roster.find(thread => thread.id === taskCoordinator(task));
}
export function tasksInCoordinatorView(tasks: BoardTask[], view: CoordinatorTaskView | undefined) {
	return view ? scopedTasks(tasks, view.coordinatorId, view.hidden) : tasks;
}
export function questionsInCoordinatorView(questions: BoardQuestion[], view: CoordinatorTaskView | undefined) {
	return view ? scopedQuestions(questions, view.threads, view.coordinatorId, view.hidden) : questions;
}
