import { createContext } from 'svelte';
import type { BackendConnection } from './harness.svelte.js';

export const [getCoordinatorCreation, provideCoordinatorCreation] = createContext<{
	open: (backend: BackendConnection, projectId: string) => void;
	isOpen: () => boolean;
}>();
