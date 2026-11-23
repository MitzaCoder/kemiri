import { expect, test } from 'bun:test';
import type { Artifact, ReportBlock, ReportBlocks } from '@kemiri/protocol';
import { automaticReportProof, readReportSection, reportBlockGroups, reportProofArtifact, type TaskReportSections } from '../src/lib/report-sections.js';
import { taskChanges } from '../src/lib/tasks.js';

const outcome = { kind: 'outcome', text: 'The desk is ready.' } as const;
const report: TaskReportSections = { results: '- Mirror result.', next: 'The crew will return.' };
const wireBlocks = (results: unknown): ReportBlocks => ({ results, next: [{ kind: 'nextAction', text: 'The crew will return.' }] }) as ReportBlocks;

test.each([
	[{ kind: 'future' }], [{ kind: 'finding', title: 'No observation' }], [{ kind: 'step', text: 'Wrong section.' }],
	[{ kind: 'setup', title: 'Invalid facts', facts: [{ label: 'Port', value: 80 }] }], [{ kind: 'metric', label: 'Wait', value: Infinity }],
	[{ kind: 'outcome', text: 'An ![image](https://example.test/image.png).' }], [null],
])('rejects the entire section when a block is unsupported or malformed (%j)', bad => {
	const mixed = { ...report, blocks: wireBlocks([outcome, bad]) };
	expect(readReportSection(mixed, 'results')).toEqual({ kind: 'mirror', markdown: report.results });
	expect(readReportSection(mixed, 'next').kind).toBe('blocks');
});

test('selects exactly one source and preserves a server-owned Markdown segment in order', () => {
	const markdown = { kind: 'markdown', text: '## Previous evidence\n\nOriginal content.' } as const;
	const blocks = [markdown, outcome];
	expect(readReportSection({ ...report, blocks: { results: blocks } }, 'results')).toEqual({ kind: 'blocks', blocks });
	expect(readReportSection({ ...report, blocks: wireBlocks('not a list') }, 'results')).toEqual({ kind: 'mirror', markdown: report.results });
	expect(readReportSection({ ...report, blocks: { results: [] } }, 'results')).toEqual({ kind: 'mirror', markdown: report.results });
});

test('groups steps without trimming exact whitespace, metacharacters or multiline copy text', () => {
	const copyText = '  cat <<\'SIGN\'\n\tUse <this> & that.\nSIGN\n\n';
	const steps = [{ kind: 'step', text: 'Write the sign.', copyText, language: 'sh' }, { kind: 'step', text: 'Print it.' }] as const;
	const section = readReportSection({ ...report, steps: '1. Mirror step.', blocks: { steps: [...steps] } }, 'steps');
	expect(section).toEqual({ kind: 'blocks', blocks: [...steps] });
	if (section.kind !== 'blocks') throw new Error('Expected typed steps');
	expect(reportBlockGroups(section.blocks)).toEqual([{ kind: 'step', blocks: [...steps] }]);
});

test('groups adjacent risks without moving them across other blocks', () => {
	const rain = { kind: 'risk', title: 'Rain', text: 'The covered area was not tested.' } as const;
	const crowd = { kind: 'risk', title: 'Crowd', text: 'Group departures were not tested.' } as const;
	const signage = { kind: 'risk', title: 'Signage', text: 'The signs were not tested after dark.' } as const;
	expect(reportBlockGroups([rain, crowd, outcome, signage])).toEqual([
		{ kind: 'risk', blocks: [rain, crowd] },
		{ kind: 'outcome', blocks: [outcome] },
		{ kind: 'risk', blocks: [signage] },
	]);
});

const proof = { kind: 'proof', text: 'The switch to the waiting list.', artifactRef: { artifactId: 'replay', version: 2 } } as const;
const retained = { id: 'replay~2', kind: 'image', version: 2 } as Artifact;
const newest = { id: 'replay~3', kind: 'image', version: 3 } as Artifact;
const replay = { ...newest, id: 'replay', versions: [retained, newest], createdAt: '2026-01-01' };
const other = { id: 'other', kind: 'video', createdAt: '2026-01-02' } as Artifact;

test('replaces a cited automatic thumbnail without shrinking Files or substituting a pruned version', () => {
	const artifacts = [replay, other];
	expect(automaticReportProof({ ...report, blocks: { results: [proof] } }, artifacts)).toEqual([other]);
	expect(artifacts).toHaveLength(2);
	expect(reportProofArtifact(proof, artifacts)?.id).toBe('replay~2');
	expect(reportProofArtifact(proof, [{ ...replay, versions: [newest] }])).toBeUndefined();
	expect(automaticReportProof({ ...report, blocks: wireBlocks([proof, { kind: 'future' }]) }, artifacts)).toEqual(artifacts);
});

const snapshot = (results: string, blocks?: ReportBlocks) => ({ title: 'Booking rehearsal', status: 'done' as const, report: { now: '', results, next: '', blocks } });
const finding = { kind: 'finding', title: 'First window', text: 'The desk accepted ten reservations.' } as const;
const results = (...blocks: Exclude<ReportBlock, { kind: 'step' | 'nextAction' }>[]) => ({ results: blocks });

test('history separates a structural conversion or proof version edit from new facts', () => {
	const legacy = snapshot('- The **desk** is ready.');
	const typed = snapshot('- The desk is ready.', results(outcome));
	expect(taskChanges(legacy, typed).sections).toEqual([{ key: 'results', label: 'Results', lines: [], structure: { added: 1, removed: 0, reordered: false } }]);
	expect(taskChanges(snapshot('Version two', results(proof)), snapshot('Version three', results({ ...proof, artifactRef: { ...proof.artifactRef, version: 3 } }))).sections[0]?.lines).toEqual([]);
});

test('history reports reorder alongside added and removed blocks without calling moved text new', () => {
	const before = snapshot('Before', results(outcome, finding, proof));
	const after = snapshot('After', results(finding, outcome, { kind: 'cleanup', text: 'The desk cleared its book.' }));
	expect(taskChanges(before, after).sections[0]).toMatchObject({
		structure: { added: 1, removed: 1, reordered: true },
		lines: [{ kind: 'removed', text: proof.text }, { kind: 'added', text: 'Cleaned up: The desk cleared its book.' }],
	});
});
