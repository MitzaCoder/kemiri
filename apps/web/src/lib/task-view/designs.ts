import type { Component, Snippet } from 'svelte';
import ClassicTaskView from '#lib/components/task-view/ClassicTaskView.svelte';
import type { TaskViewModel } from './model.svelte.js';

export type TaskViewDesignProps = {
	model: TaskViewModel;
	/** The sheet's content width is at most 40rem. */
	compact: boolean;
	/** Render this in place of the usual body when model.editing is true. */
	editor: Snippet;
	/** Task-linked correspondence, rendered inside the design's record. */
	coordinatorMessages?: { count: number; content: Snippet };
};

export type TaskViewDesign = {
	id: string;
	label: string;
	description: string;
	component: Component<TaskViewDesignProps>;
	/** Added to the full-screen dialog shell, e.g. to dock a narrower sheet on desktop. */
	sheetClass?: string;
};

export const CLASSIC_TASK_VIEW_DESIGN: TaskViewDesign = {
	id: 'classic',
	label: 'Classic',
	description: "Today's task view",
	component: ClassicTaskView,
	sheetClass: 'sm:right-0 sm:left-auto sm:w-[min(74rem,calc(100vw-3rem))] sm:max-w-none sm:rounded-l-2xl',
};

export const TASK_VIEW_DESIGNS: readonly TaskViewDesign[] = [
	CLASSIC_TASK_VIEW_DESIGN,
];

export function resolveTaskViewDesign(id: string | null): TaskViewDesign {
	return TASK_VIEW_DESIGNS.find(design => design.id === id) ?? CLASSIC_TASK_VIEW_DESIGN;
}
