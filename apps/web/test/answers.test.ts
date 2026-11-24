import { expect, test } from 'bun:test';
import { createServer } from 'vite';
import { notificationUrl } from '@kemiri/client';
import { LEGACY_HARNESS_FEATURES, type Answer, type EntryRecord } from '@kemiri/protocol';
import { answerFromUrl, answerPreview, answerRequests, answersByReply, answersSupported, groupAnswers, hasUnreadAnswers, taskQuestionRow } from '../src/lib/answers.ts';
import { visibleSidebarTabs } from '../src/lib/sidebar.ts';
import { buildTranscript } from '../src/lib/transcript.ts';

const day = (date: number, hour: number) => new Date(2026, 10, date, hour).toISOString();
const now = Date.parse(day(20, 21));
function answer(id: string, fields: Partial<Answer> = {}): Answer {
	return { id, at: day(20, 8), title: 'Recipe archive', question: 'How much room is left?', answer: 'About 24 GB.',
		coordinatorId: 'main', coordinatorTitle: 'General', filedBy: 'harness', related: [], read: true, pinned: false, exchanges: [], ...fields };
}

test('groups pinned answers first and sorts each local day newest first with numeric ID tie-breaks', () => {
	const rows = [answer('A1', { at: day(13, 12), pinned: true }), answer('A3'), answer('A4', { at: day(20, 9) }),
		answer('A5', { at: day(19, 23) }), answer('A6', { at: day(18, 9) }), answer('A12'), answer('A7', { pinned: true })];
	const groups = groupAnswers(rows, now);
	expect(groups.map(group => group.day).slice(0, 3)).toEqual(['Pinned', 'Today', 'Yesterday']);
	expect(groups.map(group => group.answers.map(row => row.id))).toEqual([['A7', 'A1'], ['A4', 'A12', 'A3'], ['A5'], ['A6']]);
	expect(groupAnswers([], now)).toEqual([]);
	expect(answerPreview('**24 GB** free.\n\nSee [details](https://example.test).')).toBe('24 GB free. See details.');
});

test('only an advertised feature shows the tab, and its dot reflects even pinned or filtered-out unread answers', () => {
	expect(answersSupported(undefined)).toBe(false);
	expect(answersSupported(LEGACY_HARNESS_FEATURES)).toBe(false);
	expect(visibleSidebarTabs(feature => feature === 'board', { answers: true })).toEqual(['board']);
	expect(visibleSidebarTabs(feature => ['board', 'answers', 'threads'].includes(feature), { answers: true, background: true })).toEqual(['board', 'answers', 'background']);
	const read = answer('A1');
	const unread = answer('A2', { pinned: true, read: false });
	expect(hasUnreadAnswers([read])).toBe(false);
	expect(hasUnreadAnswers([read, unread])).toBe(true);
	expect(hasUnreadAnswers([read, { ...unread, read: true }])).toBe(false);
});

test('answer search sends its query without changing the full-list subscription', async () => {
	const requests: unknown[] = [];
	const api = answerRequests({ request: (async request => {
		requests.push(request);
		return { type: 'answers.list', answers: [answer('A3')] };
	}) as Parameters<typeof answerRequests>[0]['request'] }, 'bakery');
	await api.list(undefined, true);
	expect((await api.list('  recipe archive  ')).answers.map(row => row.id)).toEqual(['A3']);
	await api.list(undefined, false);
	expect(requests).toEqual([
		{ type: 'answers.list', projectId: 'bakery', subscribe: true },
		{ type: 'answers.list', projectId: 'bakery', query: 'recipe archive' },
		{ type: 'answers.list', projectId: 'bakery', subscribe: false },
	]);
});

test('answer actions use the correct project, answer and request types', async () => {
	const requests: unknown[] = [];
	const api = answerRequests({ request: (async request => {
		requests.push(request);
		return { type: request.type, answer: answer('A3'), taskId: 'T9' };
	}) as Parameters<typeof answerRequests>[0]['request'] }, 'bakery');
	await api.update('A3', { read: true });
	await api.update('A3', { pinned: true });
	await api.update('A3', { pinned: false });
	await api.ask('A3', 'again');
	await api.ask('A3', 'follow-up', 'Which files can be removed?');
	expect(await api.turnIntoTask('A3')).toBe('T9');
	await api.delete('A3');
	expect(requests).toEqual([
		{ type: 'answers.update', projectId: 'bakery', answerId: 'A3', read: true },
		{ type: 'answers.update', projectId: 'bakery', answerId: 'A3', pinned: true },
		{ type: 'answers.update', projectId: 'bakery', answerId: 'A3', pinned: false },
		{ type: 'answers.ask', projectId: 'bakery', answerId: 'A3', requestId: 'again' },
		{ type: 'answers.ask', projectId: 'bakery', answerId: 'A3', requestId: 'follow-up', question: 'Which files can be removed?' },
		{ type: 'answers.turnIntoTask', projectId: 'bakery', answerId: 'A3' },
		{ type: 'answers.delete', projectId: 'bakery', answerId: 'A3' },
	]);
});

test('the chat chip only attaches once to a filed reply from its own coordinator, including earlier replies', () => {
	const row = answer('A3', { entryId: 12, exchanges: [{ ...answer('A3'), entryId: 11 }] });
	const reply = (id: number): EntryRecord => ({ id, conversationId: 1, kind: 'pi.assistant',
		model: [{ role: 'assistant', content: [{ type: 'text', text: 'First paragraph' }, { type: 'text', text: 'Second paragraph' }] }] });
	const entries = [reply(10), reply(11), reply(12)];
	const chips = (answerReplies?: ReadonlyMap<number, string>) => buildTranscript(entries, undefined, { answerReplies })
		.flatMap(item => item.kind === 'turn' ? item.parts : []).filter(part => part.type === 'text' && part.answerId);
	expect(chips(answersByReply([row], 'main'))).toHaveLength(2);
	expect(chips(answersByReply([row], 'other'))).toHaveLength(0);
	expect(chips()).toHaveLength(0);
});

test('asked-again inputs show only the owner question, not the instruction sent to the model', () => {
	const question = 'Which previews can be removed?';
	const entries: EntryRecord[] = [{ id: 1, conversationId: 1, kind: 'pi.user', data: { answerId: 'A3', ownerQuestion: question },
		model: [{ role: 'user', content: `[answer A3] File the reply as A3.\n\n${question}` }] }];
	expect(buildTranscript(entries, undefined)).toMatchObject([{ kind: 'user', text: question }]);
});

test('pop-up and inbox reply links target the answer instead of the chat, but legacy replies stay anchored', () => {
	const reply = { backendKey: 'demo', projectId: 'bakery', workerId: null, scheduleId: null, kind: 'reply' as const,
		coordinatorId: 'editor', entryId: 23, taskId: 'T1' };
	const href = notificationUrl({ ...reply, answerId: 'A3' });
	expect(href).toBe('/b/demo/projects/bakery?answer=A3');
	expect(answerFromUrl(new URL(href, 'https://example.test'))).toBe('A3');
	const legacyHref = '/b/demo/projects/bakery/threads/editor?task=T1#entry-23';
	expect(notificationUrl(reply)).toBe(legacyHref);
	expect(notificationUrl({ ...reply, kind: 'worker_report', answerId: 'A3' })).toBe(legacyHref);
	expect(notificationUrl({ ...reply, answerId: '../x' })).toBe(legacyHref);
});


test('renders task questions, working and failed errands, and the closed request copy action', async () => {
	const vite = await createServer({ root: import.meta.dir + '/..', server: { middlewareMode: true }, logLevel: 'error' });
	try {
		const { default: AnswerListRow } = await vite.ssrLoadModule('/src/lib/components/answers/AnswerListRow.svelte');
		const { default: CopyToAnswers } = await vite.ssrLoadModule('/src/lib/components/answers/CopyToAnswers.svelte');
		const { render } = await vite.ssrLoadModule('svelte/server');
		const at = '2026-11-11T10:00:00Z';
		const rows = [
			{ ...answer('A1', { at }), title: 'Refresh the menu preview', working: { workerId: 'menu-preview', status: 'running', elapsedMinutes: 2 } },
			{ ...answer('A2', { at }), title: 'Sync the print queue', working: { workerId: 'print-queue', status: 'failed', elapsedMinutes: 1 } },
			taskQuestionRow({ taskId: 'T1', feedbackId: 'F5', at, question: 'Can I print the old recipe cards?', note: 'Choose Print from the recipe.' }),
		];
		const html = rows.map(row => render(AnswerListRow, { props: {
			row, tasks: [], pathname: '/project', taskHref: (id: string) => `/project?task=${id}`,
			now: Date.parse(at) + 120_000, onnavigate() {}, onleave() {},
		} }).body).join('');
		expect(html).toContain('Can I print the old recipe cards?');
		expect(html).toContain('Choose Print from the recipe.');
		expect(html.match(/href="\/project\?task=T1"/g)).toHaveLength(2);
		expect(html).toContain('Working · menu-preview · 2 min');
		expect(html).toContain('motion-safe:animate-pulse');
		expect(html).toContain('Worker failed · print-queue');
		const copy = (status: string, parent: string | null = null, supported = true) => render(CopyToAnswers, {
			props: { task: { id: 'T1', status, parent }, supported, copy: async () => 'A3' },
		}).body;
		for (const status of ['done', 'dropped']) expect(copy(status)).toContain('Copy to Answers');
		for (const html of [copy('review'), copy('done', 'T2'), copy('done', null, false)]) expect(html).not.toContain('Copy to Answers');
	} finally { await vite.close(); }
}, 20_000);

test('copies a closed task through the Answers API', async () => {
	const api = answerRequests({ request: (async request => {
		expect(request).toEqual({ type: 'answers.copyFromTask', projectId: 'bakery', taskId: 'T1' });
		return { type: 'answers.copyFromTask', answerId: 'A9' };
	}) as Parameters<typeof answerRequests>[0]['request'] }, 'bakery');
	expect(await api.copyFromTask('T1')).toBe('A9');
});
