import { expect, test } from 'bun:test';

const component = (path: string) => Bun.file(new URL(`../src/lib/components/${path}.svelte`, import.meta.url)).text();

test('main, thread and worker Info panels show context without an Artifacts section', async () => {
	for (const name of ['ProjectChat', 'WorkerTranscript']) {
		const source = await component(name);
		expect(source).toContain('<ContextPanel');
		expect(source).not.toContain('ArtifactsSection');
		expect(source).not.toContain('{#snippet extra()}');
	}
	const context = await component('ContextPanel');
	expect(context).not.toContain('data-context-section="artifacts"');
	expect(context).not.toContain('extra?: Snippet');
});

test('artifacts remain available in project panels, task sheets and transcripts', async () => {
	expect(await component('ProjectChat')).toContain('<ArtifactStrip');
	expect(await component('BoardTaskEditor')).toContain('<ArtifactList');
	expect(await component('artifacts/TaskFiles')).toContain('<MediaGallery');
});
