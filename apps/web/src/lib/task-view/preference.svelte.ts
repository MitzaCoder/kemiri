import { resolveTaskViewDesign } from './designs.js';

export const TASK_VIEW_DESIGN_STORAGE_KEY = 'kemiri.task-view-design.v1';

function storedDesignId(): string | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage.getItem(TASK_VIEW_DESIGN_STORAGE_KEY);
	} catch {
		return null;
	}
}

class TaskViewDesignPreference {
	#id = $state(storedDesignId());
	readonly current = $derived(resolveTaskViewDesign(this.#id));

	constructor() {
		if (typeof window !== 'undefined') {
			window.addEventListener('storage', (event) => {
				if (event.key === TASK_VIEW_DESIGN_STORAGE_KEY) this.#id = event.newValue;
				else if (event.key === null) this.#id = storedDesignId();
			});
		}
	}

	set(id: string): void {
		this.#id = resolveTaskViewDesign(id).id;
		try {
			window.localStorage.setItem(TASK_VIEW_DESIGN_STORAGE_KEY, this.#id);
		} catch { /* Keep the choice in memory when storage is unavailable. */ }
	}
}

export const taskViewDesignPreference = new TaskViewDesignPreference();
