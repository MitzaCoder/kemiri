import type { Artifact, ArtifactComment, ArtifactLibraryProject, ArtifactTaskFacts, ArtifactTaskFolder, Board } from '@kemiri/protocol';
import { artifactTitle, isMarkdownArtifact, kindLabel, savedByLabel } from './artifacts.ts';
import { isHtmlArtifact } from './artifact-preview.ts';
import { comparePairs, tagsOf } from './media-gallery.ts';

export const libraryLenses = { task: 'By task', kind: 'By kind', time: 'By time', pairs: 'Before and after', living: 'Living' } as const;
export type LibraryLens = keyof typeof libraryLenses;
export type LibraryProject = ArtifactLibraryProject & { key: string; backendId: string };
export type LibraryArtifact = { key: string; artifact: Artifact; backendId: string; project: LibraryProject; task?: ArtifactTaskFacts };
export type BackendLibrary = { artifacts: Artifact[]; projects: ArtifactLibraryProject[]; tasks: ArtifactTaskFacts[] };
export const libraryKey = (...parts: string[]) => JSON.stringify(parts);

export function boardTaskFolders(projectId: string, board: Board): ArtifactTaskFolder[] {
	return board.tasks.map(({id, title, status, archived, settledAt, report}) => ({
		projectId, id, title, status, archived, settledAt, summary: report.summary,
		decisions: board.decisions.filter(decision => decision.taskId === id)
	}));
}

export function fallbackLibrary(project: ArtifactLibraryProject, artifacts: Artifact[], board?: Board): BackendLibrary {
	return { projects: [project], artifacts, tasks: board ? boardTaskFolders(project.id, board) : [] };
}

export function mergeLibraries(libraries: Iterable<[string, BackendLibrary]>): LibraryArtifact[] {
	const merged = new Map<string, LibraryArtifact>();
	for (const [backendId, { projects, tasks, artifacts }] of libraries) {
		const projectsById = new Map(projects.map(project => [project.id, project]));
		const tasksByKey = new Map(tasks.map(task => [libraryKey(task.projectId, task.id), task]));
		for (const artifact of artifacts) {
			const key = libraryKey(backendId, artifact.projectId, artifact.id);
			if (merged.has(key)) continue;
			const project = projectsById.get(artifact.projectId) ?? { id: artifact.projectId, name: artifact.projectId, archived: false };
			merged.set(key, { key, artifact, backendId, project: { ...project, backendId, key: libraryKey(backendId, project.id) },
				task: artifact.taskId ? tasksByKey.get(libraryKey(project.id, artifact.taskId)) : undefined });
		}
	}
	return [...merged.values()].sort((left, right) => Date.parse(right.artifact.createdAt) - Date.parse(left.artifact.createdAt) || left.key.localeCompare(right.key));
}

export function libraryKind(artifact: Artifact) {
	return artifact.kind === 'text' && (isHtmlArtifact(artifact) || isMarkdownArtifact(artifact)) ? 'page' : artifact.kind;
}

export function objectShape(artifact: Artifact) {
	const kind = libraryKind(artifact);
	if (kind === 'page') return 'paper';
	if (kind === 'text') return 'slip';
	if (kind === 'video' || kind === 'image') {
		const tags = tagsOf(artifact);
		if (tags.includes('phone') || tags.includes('android')) return 'phone';
		if (tags.includes('desktop') || tags.includes('web')) return 'screen';
		return kind === 'video' ? 'recording' : 'picture';
	}
	return 'file';
}

export function libraryDate(at: string) {
	return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(at));
}

export function filterLibrary(entries: LibraryArtifact[], project: string, tags: string[], search: string) {
	const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
	return entries.filter(entry => {
		const { artifact, task } = entry;
		const searchable = [artifact.name, artifactTitle(artifact), artifact.taskId, task?.title, kindLabel(libraryKind(artifact)), artifact.kind, ...tagsOf(artifact)].join(' ').toLowerCase();
		return (!project || project === entry.project.key) && tags.every(tag => tagsOf(artifact).includes(tag)) && words.every(word => searchable.includes(word));
	});
}

type LibraryShelf = { key: string; title: string; project?: LibraryProject; task?: ArtifactTaskFacts; entries: LibraryArtifact[] };
function timeShelf(at: string, now: Date) {
	const date = new Date(at);
	const week = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
	if (date >= week) return 'This week';
	if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return 'Earlier this month';
	return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date);
}

/** Input comes newest first from mergeLibraries; the first entry fixes the shelf's place. */
export function libraryShelves(entries: LibraryArtifact[], lens: Exclude<LibraryLens, 'pairs'>, now = new Date()): LibraryShelf[] {
	const shelves = new Map<string, LibraryShelf>();
	for (const entry of entries) {
		const { artifact, project, task } = entry;
		if (lens === 'living' && !artifact.living) continue;
		let shelf: LibraryShelf;
		if (lens === 'task') {
			const title = artifact.taskId ? (task?.title ?? `Task ${artifact.taskId}`) : (artifact.threadId === 'main' ? 'Main chat, no task' : `Chat, no task · ${artifact.threadId}`);
			shelf = { key: libraryKey(project.key, artifact.taskId ? 'task' : 'chat', artifact.taskId ?? artifact.threadId), title, project, task, entries: [] };
		} else {
			const title = lens === 'kind' ? kindLabel(libraryKind(artifact), true) : lens === 'time' ? timeShelf(artifact.createdAt, now) : 'Kept alive';
			shelf = { key: title, title, entries: [] };
		}
		if (!shelves.has(shelf.key)) shelves.set(shelf.key, shelf);
		shelves.get(shelf.key)!.entries.push(entry);
	}
	return [...shelves.values()];
}

/** Use the gallery's exact matching rule, within the gallery's task (or chat) scope. */
export function libraryPairs(entries: LibraryArtifact[]) {
	const pairs = new Map<string, { before: LibraryArtifact; after: LibraryArtifact }>();
	for (const shelf of libraryShelves(entries, 'task')) {
		const byId = new Map(shelf.entries.map(entry => [entry.artifact.id, entry]));
		for (const pair of new Set(comparePairs(shelf.entries.map(entry => entry.artifact)).values())) {
			const before = byId.get(pair.before.id)!;
			const after = byId.get(pair.after.id)!;
			pairs.set(after.key, { before, after });
		}
	}
	return entries.flatMap(entry => pairs.get(entry.key) ?? []);
}

/** Equal timestamps count as saved by the time the task settled. Only a visible split gets a filmstrip marker. */
export function taskDoneSplit(versions: Artifact[], settledAt: string | null | undefined): number {
	if (!settledAt) return -1;
	const split = versions.findIndex(version => Date.parse(version.createdAt) > Date.parse(settledAt));
	return split > 0 ? split : -1;
}

type HistoryEntry = { at: string } & (
	{ kind: 'save'; first: Artifact; last: Artifact; author: string } |
	{ kind: 'comment'; comment: ArtifactComment } | { kind: 'done' | 'living' }
);

export function artifactHistory(versions: Artifact[], comments: ArtifactComment[], doneAt?: string | null, livingSince?: string) {
	const history: HistoryEntry[] = [
		...versions.map(version => ({ kind: 'save' as const, at: version.createdAt, first: version, last: version, author: savedByLabel(version) })),
		...comments.map(comment => ({ kind: 'comment' as const, at: comment.at, comment })),
	];
	if (doneAt) history.push({ kind: 'done', at: doneAt });
	if (livingSince) history.push({ kind: 'living', at: livingSince });
	history.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
	const grouped: HistoryEntry[] = [];
	for (const event of history) {
		const previous = grouped.at(-1);
		if (event.kind === 'save' && previous?.kind === 'save' && previous.author === event.author && previous.last.madeForTaskId === event.first.madeForTaskId && (previous.last.version ?? 1) + 1 === event.first.version) previous.last = event.last;
		else grouped.push(event);
	}
	return grouped;
}
