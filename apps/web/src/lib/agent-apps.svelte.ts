import type { HarnessClient } from '@kemiri/client';
import type { DetectedAppPort, ProjectApp } from '@kemiri/protocol';
import { getContext, setContext } from 'svelte';

class ProjectAppsFeed {
	apps = $state<readonly ProjectApp[]>([]);
	detected = $state<readonly DetectedAppPort[]>([]);
	listenerChecksAvailable = $state<boolean>();
	loaded = $state(false);
	error = $state<string>();
	#sequence = 0;
	#offChanges: () => void;
	#offState: () => void;

	constructor(readonly client: HarnessClient, readonly projectId: string) {
		this.#offChanges = client.onAppsChanged(id => { if (id === projectId) void this.load(); });
		this.#offState = client.subscribe(state => {
			if (state.status === 'ready') void this.load();
			else { this.#sequence++; this.loaded = false; this.apps = []; this.detected = []; }
		});
		if (client.connected) void this.load();
	}

	async load(): Promise<void> {
		const sequence = ++this.#sequence;
		try {
			const { apps, detected, listenerChecksAvailable } = await this.client.listProjectApps(this.projectId);
			if (sequence !== this.#sequence) return;
			this.apps = apps;
			this.detected = detected ?? [];
			this.listenerChecksAvailable = listenerChecksAvailable;
			this.error = undefined;
			this.loaded = true;
		} catch (error) {
			if (sequence !== this.#sequence) return;
			this.apps = [];
			this.detected = [];
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	async update(appId: string, action: 'allow' | 'stop'): Promise<void> {
		if (action === 'allow') await this.client.allowApp(this.projectId, appId);
		else await this.client.unpublishApp(this.projectId, appId);
		await this.load();
	}

	async updateDetected(port: number, action: 'publish' | 'ignore'): Promise<void> {
		if (action === 'publish') await this.client.publishDetectedApp(this.projectId, port);
		else await this.client.ignoreDetectedApp(this.projectId, port);
		await this.load();
	}

	stop(): void {
		this.#sequence++;
		this.#offState();
		this.#offChanges();
	}
}

const feeds = new WeakMap<HarnessClient, Map<string, { feed: ProjectAppsFeed; users: number }>>();
export function useProjectApps(scope: () => { client: HarnessClient; projectId: string } | undefined) {
	let feed = $state<ProjectAppsFeed>();
	$effect(() => {
		const project = scope();
		if (!project) { feed = undefined; return; }
		let projects = feeds.get(project.client);
		if (!projects) feeds.set(project.client, projects = new Map());
		let entry = projects.get(project.projectId);
		if (!entry) projects.set(project.projectId, entry = { feed: new ProjectAppsFeed(project.client, project.projectId), users: 0 });
		entry.users++;
		feed = entry.feed;
		return () => {
			if (--entry.users > 0) return;
			entry.feed.stop();
			projects.delete(project.projectId);
		};
	});
	return { get current() { return feed; } };
}

const PROJECT_APPS = Symbol('project-apps');
export function provideProjectApps(project: ReturnType<typeof useProjectApps>): void {
	setContext(PROJECT_APPS, project);
}
export function projectApps(): ReturnType<typeof useProjectApps> | undefined {
	return getContext(PROJECT_APPS);
}
