import { describe, expect, test } from 'bun:test';
import fixtures from '../../../packages/protocol/test-vectors/artifact-review.json';
import { ArtifactReviewSubmission, reviewThreadId, artifactReviewKey, formatArtifactReview, loadArtifactReview, reviewText, saveArtifactReview, validateArtifactSelection, REVIEW_BLOCKS, REVIEW_SELECTION_TYPE, type ArtifactReview } from '../src/lib/artifact-review.ts';
import { ARTIFACT_REVIEW_PRELUDE } from '../src/lib/artifact-review-frame.ts';
import { artifactPageDocument } from '../src/lib/artifact-page.ts';
import { ARTIFACT_FRAME_SANDBOX, openArtifactPreview } from '../src/lib/artifact-preview.ts';
import { appendReviewDraft } from '../src/lib/artifact-review-draft.ts';

test('reviews mirror task-reply routing, otherwise retain the source conversation', () => {
	expect(reviewThreadId('T1', 'thread-sample')).toBeUndefined();
	expect(reviewThreadId(null, 'thread-sample')).toBe('thread-sample');
	expect(reviewThreadId(undefined)).toBeUndefined();
});

test('retries keep their request ID; edits and a second accepted review get fresh IDs', () => {
	let counter = 0;
	const submission = new ArtifactReviewSubmission(() => `review-${++counter}`);
	expect(submission.requestIdFor('review')).toBe('review-1');
	expect(submission.requestIdFor('review')).toBe('review-1');
	expect(submission.requestIdFor('edited review')).toBe('review-2');
	submission.accepted();
	expect(submission.requestIdFor('edited review')).toBe('review-3');
});

const frame = {};
const selected = { type: REVIEW_SELECTION_TYPE, text: 'A sentence.', section: 'Summary' };
const validate = (input: unknown) => validateArtifactSelection(frame, frame, input);

describe('artifact selection trust boundary', () => {
	test('only the mounted iframe window is trusted, not another frame or a missing frame', () => {
		expect(validateArtifactSelection({}, frame, selected)).toBeUndefined();
		expect(validateArtifactSelection(null, null, selected)).toBeUndefined();
		expect(validate(selected)).toEqual({ text: 'A sentence.', section: 'Summary' });
	});
	for (const input of [null, undefined, true, 4, 'text', [], [selected], new Date(), new String('text'), Object.create({ ...selected }), { ...selected, extra: '' }, { ...selected, html: '<b>no</b>' }, { ...selected, text: {} }, { ...selected, section: 1 }, { ...selected, elementId: null }, { ...selected, block: 'script' }, { ...selected, type: 'anything' }, { type: REVIEW_SELECTION_TYPE }, { ...selected, text: undefined }, { ...selected, [Symbol('extra')]: '' }]) {
		test('rejects non-contract input ' + String(input), () => expect(validate(input)).toBeUndefined());
	}
	test('rejects accessor properties without invoking them', () => {
		let read = false;
		const input = { ...selected };
		Object.defineProperty(input, 'text', { get() { read = true; throw new Error('getter invoked'); }, enumerable: true });
		expect(validate(input)).toBeUndefined(); expect(read).toBe(false);
	});
	test('caps fields and removes unsafe controls; markup stays literal text', () => {
		const found = validate({ type: REVIEW_SELECTION_TYPE, text: '<script>\u0000alert(1)</script>\u0085' + 'q'.repeat(5000), section: 'h'.repeat(400), elementId: 'i'.repeat(200) })!;
		expect(found.text.length).toBe(4000); expect(found.text.endsWith('…')).toBe(true);
		expect(found.text.startsWith('<script>alert(1)</script>')).toBe(true);
		expect(found.section!.length).toBe(300); expect(found.elementId!.length).toBe(120);
	});
	test('empty clears; every block label is fixed', () => {
		expect(validate({ type: REVIEW_SELECTION_TYPE, text: '' })).toEqual({ text: '' });
		for (const block of REVIEW_BLOCKS) expect(validate({ ...selected, block })?.block).toBe(block);
		expect(validate(Object.assign(Object.create(null), selected))).toEqual({ text: 'A sentence.', section: 'Summary' });
	});
});

describe('portable review Markdown', () => {
	for (const fixture of fixtures) test(fixture.name, () => expect(formatArtifactReview(fixture.artifact, fixture.review as ArtifactReview)).toBe(fixture.expected));
	test('long quotes are bounded and Markdown quotes every line', () => {
		const review: ArtifactReview = { comments: [{ text: 'x'.repeat(4001), note: '', intent: 'Cut' }], overall: '' };
		expect(formatArtifactReview({ title: 'A', id: 'sample', version: 1, name: 'a.txt' }, review).split('\n').at(-1)).toBe('> ' + 'x'.repeat(3999) + '…');
		expect(reviewText(' one\u00a0two\r\nthree \u0001 ', 30)).toBe('one two\nthree');
	});
});

function storage() {
	const entries = new Map<string, string>();
	return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, text: string) => { entries.set(key, text); }, removeItem: (key: string) => { entries.delete(key); } };
}
describe('device-local versioned reviews', () => {
	test('backend, project, artifact and version cannot collide', () => {
		const keys = [['b', 'p', 'a', 1], ['c', 'p', 'a', 1], ['b', 'q', 'a', 1], ['b', 'p', 'b', 1], ['b', 'p', 'a', 2]].map(([b,p,a,v]) => artifactReviewKey(b as string,p as string,a as string,v as number));
		expect(new Set(keys).size).toBe(5);
		expect(artifactReviewKey('b','p','a~2',2)).toBe(keys[4]!);
	});
	test('reload restores comments, edits and removal; clear removes the local copy', () => {
		const local = storage(); const key = artifactReviewKey('b','p','a',2);
		const review = fixtures[0]!.review as ArtifactReview;
		expect(saveArtifactReview(local, key, review)).toBe(true);
		expect(loadArtifactReview(local, key)).toEqual(review);
		expect(loadArtifactReview(local, artifactReviewKey('b','p','a',1))).toEqual({ comments: [], overall: '' });
		const edited = { comments: [{ ...review.comments[0]!, note: 'Updated' }], overall: '' };
		saveArtifactReview(local,key,edited); expect(loadArtifactReview(local,key)).toEqual(edited);
		saveArtifactReview(local,key,{comments:[],overall:''}); expect(local.getItem(key)).toBeNull();
	});
	test('broken or hostile local JSON is not displayed as comments', () => {
		const local=storage();
		for(const text of ['{', 'null', '[]', '{"comments":{},"overall":""}', JSON.stringify({comments:[{...selected,note:'x',intent:'Execute'}],overall:''})]) {
			local.setItem('key',text); expect(loadArtifactReview(local,'key')).toEqual({comments:[],overall:''});
		}
	});
	test('storage refusal is visible to the caller', () => {
		const local = { ...storage(), setItem: () => { throw new Error('full'); } };
		expect(saveArtifactReview(local,'key', fixtures[0]!.review as ArtifactReview)).toBe(false);
	});
});

test('appending a review preserves text, quotes and attachments and attaches the artifact task', () => {
	const draft = { text: 'Existing draft', taskId: 'T2', quotes: ['keep quote'], attachments: [] };
	expect(appendReviewDraft(draft,'Review','T1')).toEqual({...draft,text:'Existing draft\n\nReview',taskId:'T1'});
	expect(appendReviewDraft({...draft,text:''},'Review').text).toBe('Review');
	expect(draft.text).toBe('Existing draft');
});

test('review bridge is viewer-only; no sandbox grant added', () => {
	const theme = {mode:'light' as const,tokens:{}};
	expect(artifactPageDocument('<p>A</p>',theme,false,true)).toContain(ARTIFACT_REVIEW_PRELUDE);
	expect(artifactPageDocument('<p>A</p>',theme,false,false)).not.toContain(ARTIFACT_REVIEW_PRELUDE);
	const blobs: Blob[] = [];
	openArtifactPreview('<p>A</p>','a.html',{theme,createUrl: blob => {blobs.push(blob);return 'blob:synthetic';},open:()=>({}) as Window});
	return blobs[0]!.text().then(text=>{
		expect(text).not.toContain(ARTIFACT_REVIEW_PRELUDE);
		expect(ARTIFACT_FRAME_SANDBOX).toBe('allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals');
	});
});
