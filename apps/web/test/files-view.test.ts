import { expect, test } from 'bun:test';
import { fileFromUrl, fileReferences, pathInCheckout, PROJECT_ROOT, withFile } from '../src/lib/code/file-location.js';
import { fileReadState, fileRootChoices, folderKey, searchCursor, treeRows, type FileListing } from '../src/lib/code/files-view.js';
import { anchorCodeLines, codeLineDocument, codeReviewKey, formatCodeReview, type CodeReviewSource } from '../src/lib/code/code-review.js';

const metadata = { size: 12, modifiedAt: '2026-01-01T00:00:00Z' };
const worker = { kind: 'worker', workerId: 'bread-baker' } as const;
test('file links retain task context and support named roots and a line', () => {
	const url = new URL('https://bakery.example.test/project?task=T4');
	const file = { root: worker, path: 'docs/cake recipe.md', line: 17 };
	expect(fileFromUrl(new URL(withFile(url, file), url))).toEqual(file);
	expect(fileFromUrl(new URL('?file=&root=project', url))).toEqual({ root: PROJECT_ROOT, path: '', line: undefined });
	expect(fileFromUrl(new URL('?file=../bread', url))).toBeUndefined();
	expect(fileFromUrl(new URL('?file=src/bread&root=worker:../bread', url))).toBeUndefined();
	expect(withFile(new URL(withFile(url, file), url))).toBe('/project?task=T4');
});
test('path references exclude URLs, traversal and absolute paths', () => {
	expect(fileReferences('Try (src/oven.ts:8) and `README.md:3`. https://bakery.example.test/x:4 ../missing.txt:2').map(reference => [reference.path, reference.line])).toEqual([['src/oven.ts', 8], ['README.md', 3]]);
	expect(pathInCheckout('/checkout/src/oven.ts', '/checkout')).toBe('src/oven.ts');
	expect(pathInCheckout('/checkout-other/src/oven.ts', '/checkout')).toBeUndefined();
});
test('tree flattens opened folders only and separates hidden and checkout caches', () => {
	const root: FileListing = { entries: [{ name: 'src', kind: 'dir', ...metadata }], truncated: false };
	const child: FileListing = { entries: [{ name: 'oven.ts', kind: 'file', ...metadata }], truncated: true };
	const requested: string[] = [];
	const listing = (path: string) => { requested.push(path); return path ? child : root; };
	expect(treeRows('', listing, new Set()).map(row => row.path)).toEqual(['src']);
	expect(requested).toEqual(['']);
	expect(treeRows('', listing, new Set(['src'])).map(row => [row.path, row.depth])).toEqual([['src', 1], ['src/oven.ts', 2]]);
	expect(child.truncated).toBe(true);
	expect(folderKey(worker, 'src', false)).not.toBe(folderKey(worker, 'src', true));
	expect(folderKey(worker, 'src', false)).not.toBe(folderKey(PROJECT_ROOT, 'src', false));
});
test('root picker only offers workers with a workspace and active named background roots', () => {
	const roots = fileRootChoices('Bakery', [{ id: 'bread-baker', title: 'Bake bread', workspacePath: '/fixture/bread' }, {id:'shared',title:'Shared',workspacePath:null}], [
		{id:'main',title:'Main',main:true,archived:false}, {id:'bread',title:'Bread notes',main:false,archived:false}, {id:'closed',title:'Old',main:false,archived:true}]);
	expect(roots.map(choice => choice.root)).toEqual([PROJECT_ROOT, worker, {kind:'thread',threadId:'bread'}]);
});
test('search navigation wraps and empty results have no active option', () => {
	expect([searchCursor(-1, 1, 0), searchCursor(-1, -1, 4), searchCursor(3, 1, 4), searchCursor(0, -1, 4)]).toEqual([-1, 3, 0, 3]);
});
test('read state prioritizes sensitive metadata and preserves the version hash for review', () => {
	const source: CodeReviewSource = { kind: 'file', root: 'project', path: 'oven.ts', hash: 'a'.repeat(64) };
	expect(fileReadState({ ...metadata, sensitive:true,text:'not shown',hash:source.hash })).toEqual({kind:'sensitive'});
	expect(fileReadState({...metadata,binary:true,mimeType:'image/png'})).toEqual({kind:'binary',mimeType:'image/png'});
	expect(fileReadState({...metadata,size:2000000,tooLarge:true})).toEqual({kind:'too-large',size:2000000});
	const anchor = anchorCodeLines(codeLineDocument('first\n  bake()'), source.path, 'file', 2, 2)!;
	expect(formatCodeReview(source, {overall:'',comments:[{id:'one',source,anchor,note:'Check timing.'}]})).toContain(`oven.ts@${source.hash})\n\n1. Note · oven.ts · file line 2`);
	expect(codeReviewKey('fixture','bakery',source)).toBe(codeReviewKey('fixture','bakery',{...source,hash:'b'.repeat(64)}));
});
