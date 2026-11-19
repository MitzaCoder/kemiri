import { expect, test } from 'bun:test';
import { placeReviewCard, reviewPins, validateArtifactRects, watchAnchorsMessage } from '../src/lib/artifact-review-anchors.ts';
import { formatArtifactReview, loadArtifactReview, saveArtifactReview, validateArtifactSelection, loadArtifactCommentDraft, saveArtifactCommentDraft, reviewCommentCount, type ReviewStorage } from '../src/lib/artifact-review.ts';

const frame = {};
const report = (rects: string) => ({ type: 'kemiri:artifact-anchors', rects });

test('reads frame-local rectangles only from the mounted frame and exact string fields', () => {
	const message = report('*=0,1,20,30|2.3=-10,-5,100,25');
	expect(validateArtifactRects(frame, frame, message)).toEqual(new Map([
		['*', { x: 0, y: 1, width: 20, height: 30 }],
		['p:2.3', { x: -10, y: -5, width: 100, height: 25 }],
	]));
	expect(validateArtifactRects(frame, frame, report(''))).toEqual(new Map());
	expect(validateArtifactRects({}, frame, message)).toBeUndefined();
	expect(validateArtifactRects(null, null, message)).toBeUndefined();
	for (const input of [null, [], {}, { ...message, extra: '' }, { ...message, [Symbol()]: '' },
		{ ...message, rects: 42 }, { type: 'other', rects: '' }, Object.create(message),
		{ type: message.type, get rects() { throw new Error('Do not invoke getters'); } }]) {
		expect(validateArtifactRects(frame, frame, input)).toBeUndefined();
	}
});

test('rejects malformed paths, duplicate keys, non-integers and oversized reports', () => {
	for (const rects of ['p:0=1,2,3,4', '0..1=1,2,3,4', '0=1,2,-3,4', '0=1,2.5,3,4', '0=10000000,0,3,4',
		'*=1,2,3,4|*=1,2,3,4', '0=1,2,3,4|', '0=1,2,3,4\n', 'x'.repeat(40_001),
		Array.from({ length: 102 }, (_, index) => `${index}=1,2,3,4`).join('|')]) {
		expect(validateArtifactRects(frame, frame, report(rects))).toBeUndefined();
	}
});

test('only sends up to 100 distinct valid HTML paths to the frame', () => {
	expect(watchAnchorsMessage([{ anchor: 'p:0.2' }, { anchor: 'p:0.2' }, { anchor: 'p:bad|3' }, { anchor: 'm:2' }, { anchor: 's:3' }, {}, { anchor: 'p:3' }])).toBe('kemiri:watch-artifact-anchors:0.2|3');
	expect(watchAnchorsMessage(Array.from({ length: 105 }, (_, index) => ({ anchor: `p:${index}` }))).split('|')).toHaveLength(100);
});

test('pins group by anchor, clamp to visible edges and step left to avoid overlap', () => {
	const rects = validateArtifactRects(frame, frame, report('0=25,-10,200,40|1=25,0,200,50|2=0,-50,100,40|3=0,150,100,50'))!;
	const comments = ['p:0', 'p:0', 'p:1', 'p:2', 'p:3', undefined, 'm:0'].map(anchor => ({ text: 'Quote', note: 'Note', anchor }));
	const pins = reviewPins(comments, rects, { width: 200, height: 150 });
	expect(pins.map(({ anchor, comments, x, y }) => ({ anchor, comments, x, y }))).toEqual([
		{ anchor: 'p:0', comments: [0, 1], x: 178, y: 22 }, { anchor: 'p:1', comments: [2], x: 134, y: 22 },
	]);
});

test('card prefers below, then above, then fits over the target', () => {
	const surface = { width: 400, height: 300 }, card = { width: 360, height: 120 };
	expect(placeReviewCard({ x: 20, y: 10, width: 100, height: 20 }, surface, card)).toEqual({ left: 20, top: 38, side: 'below' });
	expect(placeReviewCard({ x: 390, y: 270, width: 100, height: 20 }, surface, card)).toEqual({ left: 32, top: 142, side: 'above' });
	expect(placeReviewCard({ x: -90, y: -90, width: 100, height: 300 }, surface, card)).toEqual({ left: 8, top: 172, side: 'over' });
});

test('anchors round-trip locally, old comments still load, and neither changes the formatted review', () => {
	let saved = '';
	const storage: ReviewStorage = { getItem: () => saved, setItem: (_, value) => { saved = value; }, removeItem: () => { saved = ''; } };
	const anchors = ['p:0.2', 'm:1', 's:32', undefined, 'p:bad'];
	const review = { overall: '', comments: anchors.map(anchor => ({ text: 'Quote', note: 'Note', anchor })) };
	expect(saveArtifactReview(storage, 'review', review)).toBe(true);
	const restored = loadArtifactReview(storage, 'review');
	expect(restored.comments.map(comment => comment.anchor)).toEqual(['p:0.2', 'm:1', 's:32', undefined, undefined]);
	const artifact = { title: 'Report', name: 'report.html', id: 'report', version: 1 };
	expect(formatArtifactReview(artifact, restored)).toBe(formatArtifactReview(artifact, { ...review, comments: review.comments.map(({ text, note }) => ({ text, note })) }));
	expect(validateArtifactSelection(frame, frame, { type: 'kemiri:artifact-selection', text: 'Quote', anchor: '0.2' })?.anchor).toBe('p:0.2');
	expect(validateArtifactSelection(frame, frame, { type: 'kemiri:artifact-selection', text: 'Quote', anchor: 's:32' })).toBeUndefined();
});


test('unfinished notes restore separately and stay out of the review', () => {
	const records = new Map<string, string>();
	const storage: ReviewStorage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => { records.set(key, value); }, removeItem: key => { records.delete(key); } };
	const draft = { selection: { text: 'Bread', anchor: 'p:1.2' }, note: '  Kept as typed\n', intent: 'Clarify' as const, index: 1 };
	expect(saveArtifactCommentDraft(storage, 'version-one', draft)).toBe(true);
	expect(loadArtifactCommentDraft(storage, 'version-one')).toEqual(draft);
	const savedComment = { ...draft.selection, intent: 'Keep' as const, note: 'Previously saved' };
	expect(saveArtifactCommentDraft(storage, 'version-one', { ...draft, selection: savedComment })).toBe(true);
	expect(loadArtifactCommentDraft(storage, 'version-one')).toEqual(draft);
	expect(loadArtifactCommentDraft(storage, 'version-two')).toBeUndefined();
	expect(loadArtifactReview(storage, 'version-one')).toEqual({ comments: [], overall: '' });
	expect(saveArtifactCommentDraft(storage, 'version-one')).toBe(true);
	expect(loadArtifactCommentDraft(storage, 'version-one')).toBeUndefined();
	expect(reviewCommentCount(1)).toBe('1 comment');
	expect(reviewCommentCount(0)).toBe('0 comments');
	expect(reviewCommentCount(2)).toBe('2 comments');
});
