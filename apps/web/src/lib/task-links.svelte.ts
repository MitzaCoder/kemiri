/**
 * What the chat's components need to name a task: whether it is on the board, its title, where it opens. A screen
 * that has the board offers them with `provideTaskLinks`; without them (a worker's transcript, a server without the
 * `task-reports` feature) the chat shows no task links and every line still reads on its own.
 */
import { getContext, setContext } from "svelte";
import type { BoardTask, BoardTaskStatus } from "@kemiri/protocol";
import { taskStateStatus } from "./task-state.js";
import { taskHref } from "./task-chat.ts";

type LinkedTask = Pick<BoardTask, "id" | "title" | "status" | "state" | "waiting">;

export type TaskLinks = {
	task: (taskId: string) => LinkedTask | undefined;
	/** The title of a task on the board; undefined for a task the board does not hold (or has not loaded). */
	title: (taskId: string) => string | undefined;
	/** The status of a task on the board, so its chip wears the same colour as its row. */
	status: (taskId: string) => BoardTaskStatus | undefined;
	href: (taskId: string) => string;
};

const KEY = Symbol("task-links");

export function provideTaskLinks(links: () => TaskLinks | undefined): void {
	setContext(KEY, links);
}

/** Call while a component initialises; the returned function reads the links as they change (undefined outside a screen that offers them). */
export function useTaskLinks(): () => TaskLinks | undefined {
	return getContext<(() => TaskLinks | undefined) | undefined>(KEY) ?? (() => undefined);
}

export function boardTaskLinks(
	tasks: () => readonly LinkedTask[],
): TaskLinks {
	const task = (taskId: string) => tasks().find(item => item.id === taskId);
	return {
		task,
		title: (taskId) => task(taskId)?.title,
		status: (taskId) => { const found = task(taskId); return found && taskStateStatus(found); },
		href: taskHref,
	};
}
