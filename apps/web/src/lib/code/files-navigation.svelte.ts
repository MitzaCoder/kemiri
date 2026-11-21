import { getContext, setContext } from 'svelte';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import type { CodeRoot } from '@kemiri/protocol';
import { fileFromUrl, withFile, type FileLocation } from './file-location.js';

const context = Symbol('file navigation');
export function provideFilesNavigation(available: () => boolean, root: () => CodeRoot, checkout: () => string | undefined) {
	const navigation = {
		available, root, checkout,
		href(path: string, line?: number) { return withFile(page.url, { root: root(), path, line }); },
		open(path = '', line?: number, search = false, checkoutRoot?: CodeRoot) {
			const from = withFile(page.url);
			const openFile = fileFromUrl(page.url);
			return goto(withFile(page.url, { root: checkoutRoot ?? openFile?.root ?? root(), path, line }), { replace: !!openFile, reset: false, persistState: true,
				state: { ...page.state, filesFrom: openFile ? page.state.filesFrom : from, searchFiles: search } });
		},
	};
	setContext(context, navigation);
	return navigation;
}
export type FilesNavigation = ReturnType<typeof provideFilesNavigation>;
export const useFilesNavigation = () => getContext<FilesNavigation | undefined>(context);
export function selectFileLocation(file: FileLocation): Promise<void> {
	return goto(withFile(page.url, file), { replace: !!fileFromUrl(page.url), reset: false, persistState: true, state: page.state });
}
export function closeFiles(): void {
	const back = withFile(page.url);
	if (page.state.filesFrom === back) history.back();
	else void goto(back, { replace: true, reset: false, persistState: true, state: page.state });
}
