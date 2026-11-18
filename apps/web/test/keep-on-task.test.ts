import { expect, test } from 'bun:test';
import type { HarnessClient } from '@kemiri/client';
import type { EntryRecord } from '@kemiri/protocol';
import { canKeepOnTask, feedbackFromHash, keepOnTask, replyTasksByPart, taskFeedbackAnchor } from '../src/lib/chat/keep-on-task.ts';
import { buildTranscript } from '../src/lib/transcript.ts';

const reply = { conversationId: 12, entryId: 34 };

function entry(id: number, kind: 'pi.user' | 'pi.assistant', texts: string[]): EntryRecord {
	return { id, conversationId: 12, kind, model: [{ role: kind === 'pi.user' ? 'user' : 'assistant', content: texts.map(text => ({ type: 'text', text })) }] };
}

test('only committed assistant text contributes cards, grouped once per entry in mention order', () => {
	const items = buildTranscript([
		entry(31, 'pi.user', ['Look at T10']),
		entry(32, 'pi.user', ['[worker owl reported]\nT11 is fine.']),
		entry(34, 'pi.assistant', ['T3 and [T4](?task=T4). Ignore `T5` and [outside](https://example.test/T6).', '**T3** and T7']),
		entry(35, 'pi.assistant', ['T9 is a different reply.']),
	], undefined);
	expect(items.some(item => item.kind === 'report')).toBe(true);
	const turns = items.filter(item => item.kind === 'turn');
	const parts = turns.flatMap(turn => turn.parts);
	const mentions = replyTasksByPart([...parts, { type: 'text', key: 'live', text: 'T13 is still streaming' }]);
	expect([...mentions.values()]).toEqual([
		{ reply, taskIds: ['T3', 'T4', 'T7'] },
		{ reply: { conversationId: 12, entryId: 35 }, taskIds: ['T9'] },
	]);
	const lastText = parts.find(part => part.type === 'text' && part.text === '**T3** and T7');
	expect(mentions.has(lastText!.key)).toBe(true);
});

test('the backend must opt in and the task must still be open to offer Keep on task', () => {
	expect(canKeepOnTask(false, { status: 'review', archived: false })).toBe(false);
	expect(canKeepOnTask(true, { status: 'review', archived: false })).toBe(true);
	expect(canKeepOnTask(true, { status: 'done', archived: false })).toBe(false);
	expect(canKeepOnTask(true, { status: 'dropped', archived: false })).toBe(false);
	expect(canKeepOnTask(true, { status: 'todo', archived: true })).toBe(false);
});

test('the request names the committed reply entry and returns the note ID', async () => {
	const sent: unknown[] = [];
	const client = { request: async (request: unknown) => {
		sent.push(request);
		return { type: 'board.keepOnTask', id: 'request', feedbackId: 'F2' };
	} } as Pick<HarnessClient, 'request'>;
	const note = await keepOnTask(client, 'project-demo', 'T3', reply);
	expect(sent).toEqual([{ type: 'board.keepOnTask', projectId: 'project-demo', taskId: 'T3', conversationId: 12, entryId: 34 }]);
	expect(feedbackFromHash(`#${taskFeedbackAnchor(note)}`)).toBe('F2');
	expect(feedbackFromHash('#unrelated')).toBeUndefined();
});

test('known errors are readable and leave the action retryable', async () => {
	const client = { request: async () => ({ type: 'error', id: 'request', error: { code: 'no_coordinator_model', message: 'opaque backend text' } }) } as Pick<HarnessClient, 'request'>;
	await expect(keepOnTask(client, 'project-demo', 'T3', reply)).rejects.toThrow('Set a coordinator model');
});
