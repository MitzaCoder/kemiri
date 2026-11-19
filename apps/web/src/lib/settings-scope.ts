import type { CurrentProject } from './projects.ts';

export const LAST_PROJECT_KEY = 'aiki.last-project.v1';
export const LAST_COMPUTER_KEY = 'aiki.last-settings-computer.v1';

type ScopeComputer = {
	id: string;
	ready: boolean;
	projectsLoaded: boolean;
	projects: readonly { id: string; archived?: boolean }[];
};

export function parseLastProject(raw: string | null): CurrentProject | undefined {
	try {
		const project = raw === null ? undefined : JSON.parse(raw);
		if (typeof project?.backendId === 'string' && project.backendId && typeof project.projectId === 'string' && project.projectId) {
			return { backendId: project.backendId, projectId: project.projectId };
		}
	} catch { /* Device storage is optional. */ }
}

export function resolveSettingsProject(
	computers: readonly ScopeComputer[],
	context: CurrentProject | undefined,
	lastProject: CurrentProject | undefined,
): CurrentProject | undefined {
	for (const target of [context, lastProject]) {
		if (!target) continue;
		const computer = computers.find(computer => computer.id === target.backendId);
		if (computer && (!computer.projectsLoaded || computer.projects.some(project => project.id === target.projectId))) return target;
	}
	for (const computer of computers) {
		if (!computer.ready) continue;
		const project = computer.projects.find(project => !project.archived);
		if (project) return { backendId: computer.id, projectId: project.id };
	}
}

export function resolveSettingsComputer(
	computers: readonly ScopeComputer[],
	context: CurrentProject | undefined,
	lastComputerId: string | null,
): string | undefined {
	return computers.find(computer => computer.id === context?.backendId)?.id
		?? (computers.length === 1 ? computers[0]?.id : computers.find(computer => computer.id === lastComputerId)?.id)
		?? computers.find(computer => computer.ready)?.id ?? computers[0]?.id;
}
