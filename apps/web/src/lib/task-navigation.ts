/** The return label is the task actually opened from, never an inferred parent relation. */
export interface TaskVisit { id: string; title: string }

export function drillIntoTask(trail: readonly TaskVisit[] | undefined, from: TaskVisit, to: string): TaskVisit[] | undefined {
	return from.id === to ? undefined : [...(trail ?? []), { id: from.id, title: from.title }];
}
