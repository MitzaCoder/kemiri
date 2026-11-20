import type { Artifact, BoardTask } from '@kemiri/protocol';
import { artifactTitle } from './artifacts.ts';
import type { Draft } from './drafts.ts';

export interface DiscussionReference { title: string; artifactId: string; version: number; name: string; header: string; body: string }

export function discussHeader(artifact: Pick<Artifact, 'id' | 'title' | 'name' | 'version'>): string {
	const title = artifactTitle(artifact).replace(/[\r\n]+/g, ' ').replaceAll('"', '′');
	const name = artifact.name.replace(/[\r\n]+/g, ' ');
	return `Discuss "${title}"\n(artifact ${artifact.id.replace(/~\d+$/, '')}~${artifact.version ?? 1}, ${name})`;
}

export function discussionReference(text: string): DiscussionReference | undefined {
	const found = /^Discuss "([^"\r\n]+)"\r?\n\(artifact ([\w-]+)~([1-9]\d*), ([^\r\n]+)\)(?:\r?\n\r?\n|$)/.exec(text);
	if (!found) return undefined;
	const version = Number(found[3]);
	if (!Number.isSafeInteger(version)) return undefined;
	return { title: found[1]!, artifactId: found[2]!, version, name: found[4]!, header: found[0].trimEnd(), body: text.slice(found[0].length) };
}

export function discussionText(header: string, body: string): string { return body ? `${header}\n\n${body}` : header; }

export function attachDiscussion(draft: Draft, header: string, taskId?: string): Draft {
	const { taskId: _previousTask, ...rest } = draft;
	return { ...rest, text: discussionText(header, discussionReference(draft.text)?.body ?? draft.text), ...(taskId ? { taskId } : {}) };
}

export function settledDiscussionTask(task: Pick<BoardTask, 'status'> | undefined) {
	return task?.status === 'done' || task?.status === 'dropped';
}

/** Do not reach back to old follow-ups, or drop another one after the selected task was already dropped. */
export function newestDiscussionFollowUp(tasks: readonly BoardTask[], homeId: string, sentAt: number) {
	return tasks.filter(task => task.foundWhile === homeId && task.createdBy === 'coordinator' && Date.parse(task.createdAt) > sentAt)
		.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id, undefined, { numeric: true }))[0];
}
