import { expect, test } from 'bun:test';
import { ClientError } from '@kemiri/client';
import { changeFileDisplay, changeReadProblem, changesFromUrl, refreshedWorkingSelection, withChanges, workingChangeHeading, type ChangeList } from '../src/lib/code/project-changes.js';
import { fileFromUrl, PROJECT_ROOT, withFile } from '../src/lib/code/file-location.js';
import { formatCodeReview, type CodeReviewSource } from '../src/lib/code/code-review.js';

const page = new URL('https://bakery.example.test/b/example/projects/bakery?task=T4');
const source = { kind:'working', root:{kind:'worker',workerId:'baker'} } as const;
const baseCommit = 'abc123'.repeat(7).slice(0, 40);
const readAt = '2026-02-01T12:00:00Z';
const empty: ChangeList = {baseCommit, readAt, commits:[], files:[], truncated:false};
const oneFile: ChangeList = {...empty,files:[{path:'oven.ts',status:'modified',binary:false,additions:1,deletions:1}]};

test('working URLs pin a named root and preserve task context across the Files switch', () => {
	const open = new URL(withChanges(page, source), page);
	expect(open.searchParams.get('root')).toBe('worker:baker');
	expect(changesFromUrl(open)).toEqual(source);
	expect(changesFromUrl(new URL(withChanges(page, {kind:'working',root:PROJECT_ROOT}), page))).toEqual({kind:'working',root:PROJECT_ROOT});
	expect(changesFromUrl(new URL('?changes=working', page))).toBeUndefined();
	expect(changesFromUrl(new URL('?changes=working&root=worker:../baker', page))).toBeUndefined();
	const files = new URL(withFile(open, {root:source.root,path:'oven.ts'}), page);
	expect(withFile(files)).toBe(withChanges(page, source));
	expect(withChanges(open)).toBe(page.pathname + '?task=T4');
	const otherFiles = new URL(withFile(files, {root: PROJECT_ROOT, path: ''}), page);
	expect(fileFromUrl(otherFiles)?.root).toEqual(PROJECT_ROOT);
	expect(changesFromUrl(otherFiles)).toEqual(source);
	expect(withFile(otherFiles)).toBe(withChanges(page, source));
	expect(fileFromUrl(new URL(withChanges(otherFiles), page))?.root).toEqual(PROJECT_ROOT);
});
test('the scan heading names the base and time, including for a clean or unborn checkout', () => {
	expect(workingChangeHeading('Bakery checkout',empty, time => time)).toBe(`Uncommitted · Bakery checkout · against ${baseCommit.slice(0,12)} · as of ${readAt}`);
	expect(workingChangeHeading('Bakery checkout',{...empty,baseCommit:null}, () => '12:00')).toContain('against empty base · as of 12:00');
	expect(empty.files).toEqual([]);
});
test('refresh keeps a still-changed file, but keeps Viewed only on the same base', () => {
	const viewed = new Set(['oven.ts','gone.md']);
	expect(refreshedWorkingSelection(oneFile,oneFile,'oven.ts',viewed)).toEqual({selected:'oven.ts',viewed:new Set(['oven.ts'])});
	expect(refreshedWorkingSelection(oneFile,{...oneFile,baseCommit:null},'oven.ts',viewed)).toEqual({selected:'oven.ts',viewed:new Set()});
	expect(refreshedWorkingSelection(oneFile,empty,'oven.ts',viewed)).toEqual({selected:undefined,viewed:new Set()});
});
test('protects hidden diffs and labels review messages as uncommitted', () => {
	expect(changeFileDisplay({sensitive:true,binary:true})).toEqual({kind:'sensitive'});
	expect(changeReadProblem(new ClientError('not_found','No checkout for this code root'))).toBe('This checkout is no longer available.');
	const review: CodeReviewSource = {kind:'working',root:'worker:baker',name:'Bread preparation'};
	expect(formatCodeReview(review,{comments:[],overall:'Check the latest schedule.'})).toBe('Code review (uncommitted lines in Bread preparation (worker:baker))\n\nOverall: Check the latest schedule.');
});
