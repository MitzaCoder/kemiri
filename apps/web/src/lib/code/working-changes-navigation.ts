import { goto } from '$app/navigation';
import { page } from '$app/state';
import type { CodeRoot } from '@kemiri/protocol';
import { fileFromUrl, withFile } from './file-location.js';
import { changesFromUrl, withChanges } from './project-changes.js';

export function openWorkingChanges(root: CodeRoot) {
	const from = withChanges(page.url);
	const target = new URL(withFile(page.url), page.url.href);
	return goto(withChanges(target, { kind: 'working', root }), {
		replace: !!fileFromUrl(page.url) || !!changesFromUrl(page.url), reset: false, persistState: true,
		state: { ...page.state, changesFrom: fileFromUrl(page.url) ? page.state.filesFrom : from },
	});
}
