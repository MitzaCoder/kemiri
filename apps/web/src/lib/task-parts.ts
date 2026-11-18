import type { BoardTask, BoardTaskState } from '@kemiri/protocol';

export type PartTone = 'done' | 'working' | 'needs-you' | 'other';
export function partTone(kind: BoardTaskState['kind']): PartTone {
	if (kind === 'done') return 'done';
	if (kind === 'working') return 'working';
	if (['failed', 'answer_needed', 'steps_needed', 'review'].includes(kind)) return 'needs-you';
	return 'other';
}

/** Stable colour order, with proportional shares rather than tiny segments above twelve parts. */
export function taskPartProgress(task: Pick<BoardTask, 'subtaskStates'>) {
	const states = task.subtaskStates?.filter(kind => kind !== 'dropped');
	if (!states?.length) return undefined;
	const tones: PartTone[] = ['done', 'working', 'needs-you', 'other'];
	const counts = tones.map(tone => ({ tone, count: states.filter(kind => partTone(kind) === tone).length }));
	const [done, working, needsYou] = counts.map(group => group.count);
	const text = `${done} of ${states.length} parts done${working ? ` · ${working} working` : ''}${needsYou ? ` · ${needsYou} needs you` : ''}`;
	const segments = states.length > 12 ? counts.filter(group => group.count > 0) : counts.flatMap(group => Array.from({ length: group.count }, () => ({ tone: group.tone, count: 1 })));
	return { text, segments, proportional: states.length > 12 };
}

export function taskUsesPartsSentence(task: Pick<BoardTask, 'state' | 'subtaskStates'>): boolean {
	return !!taskPartProgress(task) && (task.state?.group === 'in_progress' || task.state?.group === 'todo');
}
