import { getContext, setContext } from 'svelte';

const key = Symbol('open-task-details');

export function provideOpenTaskId(read: () => string | undefined): void {
	setContext(key, read);
}

export function useOpenTaskId(): () => string | undefined {
	return getContext<(() => string | undefined) | undefined>(key) ?? (() => undefined);
}
