import { expect, test } from 'bun:test';
import type { Artifact, ArtifactsChangedEvent } from '@kemiri/protocol';
import { applyProjectArtifactChange, projectArtifactSections } from '../src/lib/project-artifacts.ts';
import { visibleSidebarTabs } from '../src/lib/sidebar.ts';

const artifact = (id: string, minute: string, metadata: Partial<Artifact> = {}): Artifact => ({
	id, projectId: 'garden', name: `${id}.html`, title: null, note: null, kind: 'text', mimeType: 'text/html', size: 1,
	durationSeconds: null, threadId: 'main', workerId: null, taskId: null, sourcePath: 'example.html',
	createdAt: `2026-01-01T12:${minute}:00.000Z`, ...metadata,
});

const titles = new Map([['T1', 'Plant seedlings']]);

test('search and sectioning use project artifact and home task metadata', () => {
	const guide = artifact('guide', '00', { pinned: true, taskId: 'T1' });
	const newer = artifact('map', '01', { tags: ['courtyard'] });
	const image = artifact('layout', '02', { name: 'layout.png', mimeType: 'image/png', kind: 'image' });
	const catalogue = [image, newer, guide];
	expect(projectArtifactSections(catalogue, '', titles)).toEqual({ pinned: [guide], html: [newer], other: [image] });
	expect(projectArtifactSections(catalogue, 'SEEDLINGS guide', titles).pinned).toEqual([guide]);
	expect(projectArtifactSections(catalogue, 'courtyard', titles).html).toEqual([newer]);
	expect(projectArtifactSections(catalogue, 'layout.png', titles).other).toEqual([image]);
});

test('live changes move a pin without replacing the catalogue or loading history', () => {
	const guide = artifact('guide', '00', { pinned: true });
	const map = artifact('map', '01');
	const before = [map, guide];
	const change: ArtifactsChangedEvent = { type: 'artifacts.changed', projectId: 'garden', artifact: { ...map, pinned: true, versions: [map] }, deleted: false };
	const updated = applyProjectArtifactChange(before, change, 'garden');
	expect(projectArtifactSections(updated, '', titles).pinned.map(row => row.id)).toEqual(['map', 'guide']);
	expect(updated[0]).not.toHaveProperty('versions');
	expect(applyProjectArtifactChange(updated, { ...change, projectId: 'elsewhere' }, 'garden')).toBe(updated);
	expect(applyProjectArtifactChange(updated, { ...change, deleted: true }, 'garden')).toEqual([guide]);
});

test('the project panel is beside Info and advertised separately from Vitrine', () => {
	const features = ['board', 'context', 'project-artifacts', 'memory'];
	expect(visibleSidebarTabs(feature => features.includes(feature))).toEqual(['board', 'info', 'artifacts', 'memory']);
	expect(visibleSidebarTabs(feature => feature === 'artifact-library')).toEqual([]);
});
