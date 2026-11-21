import { expect, test } from 'bun:test';
import { ChangeSet, Text } from '@codemirror/state';
import { beginFileSave, canEditFile, changeFileEdit, directEditDraft, fileWritesEnabled, finishFileSave, guardFileNavigation, openFileEdit, showFileWriteSetting, useDiskVersion } from '../src/lib/code/file-edit.js';
import { fileLineEndings } from '../src/lib/code/file-line-endings.js';
import { PROJECT_ROOT } from '../src/lib/code/file-location.js';

const base = { text: 'Old schedule\n', hash: 'old' };
const disk = { text: 'New schedule from disk\n', hash: 'disk' };
const clean = openFileEdit(base);
const dirty = changeFileEdit(clean, 'My schedule\n');
const saving = beginFileSave(dirty)!;
const conflict = finishFileSave(saving, {status:'conflict', current:disk});
const saved = finishFileSave(saving, {status:'saved', hash:'new', size:12, modifiedAt:'2026-01-01T00:00:00Z'});

test('Save compares against the read hash, adopts the saved hash, and keeps undo-to-base clean', () => {
	expect(clean.kind).toBe('clean');
	expect(beginFileSave(clean)).toBeUndefined();
	expect(dirty.kind).toBe('dirty');
	expect(changeFileEdit(dirty,base.text)).toEqual(clean);
	expect(saving).toEqual({...dirty,kind:'saving'});
	expect(beginFileSave(saving)).toBeUndefined();
	expect(changeFileEdit(saving,'not this')).toBe(saving);
	expect(saved).toEqual({kind:'saved',base:{text:dirty.text,hash:'new'},text:dirty.text});
	expect(beginFileSave(changeFileEdit(saved,'New draft'))?.base.hash).toBe('new');
});
test('Conflict requires a choice, then uses the disk hash for a guarded retry', () => {
	expect(conflict.kind).toBe('conflict');
	expect(useDiskVersion(conflict)).toEqual(disk);
	expect(beginFileSave(conflict)).toBeUndefined();
	const retry = beginFileSave(conflict,true)!;
	expect(retry).toEqual({base:disk,text:dirty.text,kind:'saving'});
	const newerDisk = {...disk,hash:'newer disk'};
	expect(useDiskVersion(finishFileSave(retry,{status:'conflict',current:newerDisk}))).toEqual(newerDisk);
});
test('An error retains the draft and retry hash', () => {
	const error = {...saving,kind:'error' as const,message:'The connection closed.'};
	expect(beginFileSave(error)).toEqual(saving);
	expect(beginFileSave(changeFileEdit(clean,'x'.repeat(1024*1024+1)))).toMatchObject({kind:'error',base});
});
test('The guard covers close, file and root switches, Back, and browser unload', () => {
	const from = new URL('https://bakery.example.test/projects/bakery?file=hours.txt');
	for (const to of ['?', '?file=menu.txt', '?file=hours.txt&root=thread:bread', '/projects/market?file=hours.txt']) {
		expect(guardFileNavigation(dirty,from,new URL(to,from),false)).toBe('confirm');
		expect(guardFileNavigation(saved,from,new URL(to,from),false)).toBe('allow');
	}
	expect(guardFileNavigation(dirty,from,new URL('?file=hours.txt&line=4',from),false)).toBe('allow');
	expect(guardFileNavigation(dirty,from,undefined,true)).toBe('unload');
	expect(guardFileNavigation(conflict,from,undefined,true)).toBe('unload');
	expect(guardFileNavigation(clean,from,undefined,true)).toBe('allow');
});
test('Edit requires both switches and an eligible project file', () => {
	const features = ['project-files-write'];
	const file = {...base,size:13,modifiedAt:'2026-01-01T00:00:00Z'};
	expect(showFileWriteSetting(undefined)).toBe(false);
	expect(showFileWriteSetting(features)).toBe(true);
	expect(fileWritesEnabled(features,undefined)).toBe(false);
	expect(fileWritesEnabled(features,false)).toBe(false);
	expect(fileWritesEnabled([],true)).toBe(false);
	expect(fileWritesEnabled(features,true)).toBe(true);
	expect(canEditFile(true,PROJECT_ROOT,file,false)).toBe(true);
	expect(canEditFile(true,PROJECT_ROOT,file,true)).toBe(false);
	for (const flag of ['sensitive','binary','tooLarge'] as const) expect(canEditFile(true,PROJECT_ROOT,{...file,[flag]:true},false)).toBe(false);
	expect(canEditFile(true,{kind:'worker',workerId:'baker'},file,false)).toBe(false);
	expect(canEditFile(true,{kind:'thread',threadId:'bread'},file,false)).toBe(false);
});
test('Tell the agent drafts one line even for a path with line breaks', () => {
	expect(directEditDraft('bakery/hours.txt')).toBe('I edited bakery/hours.txt directly');
	expect(directEditDraft('bakery/weekend\nhours.txt')).toBe('I edited bakery/weekend hours.txt directly');
});
test('Edits do not normalize untouched line endings', () => {
	const raw = 'alpha\r\nbeta\ngamma\rdelta';
	const endings = fileLineEndings(raw);
	const before = Text.of(endings.lines);
	const changes = ChangeSet.of([{from:0,to:5,insert:'ALPHA'},{from:6,insert:'inserted\n'}],before.length);
	const after = changes.apply(before);
	expect(endings.update(changes,before,after)).toBe('ALPHA\r\ninserted\r\nbeta\ngamma\rdelta');
	expect(endings.update(changes.invert(before),after,before)).toBe(raw);
	const crlf = fileLineEndings('a\r\nb');
	const crlfBefore = Text.of(crlf.lines);
	const append = ChangeSet.of({from:3,insert:'\nc'},crlfBefore.length);
	expect(crlf.update(append,crlfBefore,append.apply(crlfBefore))).toBe('a\r\nb\r\nc');
});
