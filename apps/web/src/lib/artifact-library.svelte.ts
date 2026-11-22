import type { Artifact, ArtifactsChangedEvent } from '@kemiri/protocol';
import { untrack } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { ArtifactLibraryRefresh } from './artifact-library-refresh.js';
import { fallbackLibrary, mergeLibraries, type BackendLibrary } from './artifact-library.js';
import { harness, type BackendConnection } from './harness.svelte.js';

export const supportsArtifactLibrary = (backend: BackendConnection) => backend.connection.features?.includes('artifact-library') === true;

class BackendArtifactLibrary {
	library = $state.raw<BackendLibrary>({ artifacts: [], projects: [], tasks: [] });
	loaded = $state(false);
	problem = $state('');
	readonly refresh = new ArtifactLibraryRefresh(isCurrent => this.#load(isCurrent));
	#unsubscribe: (() => void) | undefined;
	stopLoading?: () => void;

	constructor(readonly backend: BackendConnection) {}

	setActive(active: boolean) {
		if (active) {
			this.#unsubscribe ??= this.backend.client.onArtifactsChanged(event => {
				this.apply(event);
				this.refresh.artifactsChanged();
			});
			this.loaded = false;
		} else {
			this.#unsubscribe?.();
			this.#unsubscribe = undefined;
		}
		this.refresh.setActive(active);
	}

	apply(event: ArtifactsChangedEvent) {
		const rest = this.library.artifacts.filter(artifact => artifact.projectId !== event.projectId || artifact.id !== event.artifact.id);
		this.library = { ...this.library, artifacts: event.deleted ? rest : [event.artifact, ...rest] };
	}

	async #load(isCurrent: () => boolean) {
		try {
			const library: BackendLibrary = { artifacts: [], projects: [], tasks: [] };
			let partial = false;
			if (supportsArtifactLibrary(this.backend)) {
				let before: string | undefined;
				const cursors = new Set<string>();
				do {
					const page = await this.backend.client.readArtifactLibrary(before);
					if (!isCurrent()) return;
					library.artifacts.push(...page.artifacts);
					library.projects.push(...page.projects);
					library.tasks.push(...page.tasks);
					before = page.nextBefore ?? undefined;
					if (before && cursors.has(before)) throw new Error('The artifact library repeated a page.');
					if (before) cursors.add(before);
				} while (before);
			} else {
				const projects = this.backend.projects;
				// Read a few projects at a time. A board read can be refused without losing that project's artifacts.
				for (let offset = 0; offset < projects.length; offset += 4) {
					const reads = await Promise.allSettled(projects.slice(offset, offset + 4).map(async project => {
						const [artifacts, board] = await Promise.all([
							this.backend.client.listArtifacts(project.id, { limit: 500 }),
							this.backend.client.readBoard(project.id, { includeArchived: true }).catch(() => undefined)
						]);
						return fallbackLibrary({ id: project.id, name: project.name, archived: project.archived === true }, artifacts, board);
					}));
					if (!isCurrent()) return;
					for (const read of reads) {
						if (read.status === 'rejected') { partial = true; continue; }
						library.artifacts.push(...read.value.artifacts);
						library.projects.push(...read.value.projects);
						library.tasks.push(...read.value.tasks);
					}
				}
			}
			if (!isCurrent()) return;
			this.library = library;
			this.problem = partial ? 'Some projects could not be read.' : '';
		} catch (error) {
			if (isCurrent()) this.problem = error instanceof Error ? error.message : String(error);
		} finally {
			if (isCurrent()) this.loaded = true;
		}
	}

	stop() {
		this.stopLoading?.();
		this.setActive(false);
	}
}

class ArtifactLibrary {
	#backends = new SvelteMap<string, BackendArtifactLibrary>();
	entries = $derived(mergeLibraries([...this.#backends].map(([id, feed]) => [id, feed.library])));
	loading = $derived([...this.#backends.values()].some(feed => feed.backend.ready && !feed.loaded));
	problems = $derived([...this.#backends.values()].flatMap(feed => feed.problem ? [`${feed.backend.name}: ${feed.problem}`] : []));

	upsert(backendId: string, artifact: Artifact) {
		this.#backends.get(backendId)?.apply({ type: 'artifacts.changed', projectId: artifact.projectId, artifact, deleted: false });
	}

	retry() { for (const feed of this.#backends.values()) feed.refresh.refresh(); }

	connect(isOpen: () => boolean) {
		$effect(() => {
			const backends = harness.backends;
			untrack(() => {
				for (const [id, feed] of this.#backends) {
					if (!backends.includes(feed.backend)) { feed.stop(); this.#backends.delete(id); }
				}
				for (const backend of backends) {
					if (this.#backends.has(backend.id)) continue;
					const feed = new BackendArtifactLibrary(backend);
					this.#backends.set(backend.id, feed);
					feed.stopLoading = $effect.root(() => {
						$effect(() => {
							if (!isOpen() || !backend.ready) return;
							if (!supportsArtifactLibrary(backend)) {
								// Reading the lazy getter subscribes before waiting for old backends' project lists.
								void backend.projects;
								if (!backend.projectsLoaded) return;
							}
							untrack(() => feed.setActive(true));
							return () => feed.setActive(false);
						});
					});
				}
			});
		});
	}
}

export const artifactLibrary = new ArtifactLibrary();
