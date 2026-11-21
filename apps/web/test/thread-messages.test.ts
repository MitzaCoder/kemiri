import { expect, test } from 'bun:test';
import type { EntryRecord, ThreadMessage } from '@kemiri/protocol';
import { threadMessageCard, threadMessageHref, threadMessageStatus } from '../src/lib/thread-messages.ts';
import { buildTranscript } from '../src/lib/transcript.ts';

const message: ThreadMessage = { id: 'thread-message:one', from: 'shop', to: 'kitchen', kind: 'request', awaitReply: true,
	taskId: 'T2', text: 'How many boxes?\nBy noon.', firstLine: 'How many boxes?', at: '2026-01-01T10:00:00Z' };
const title = (id: string) => id === 'kitchen' ? 'Kitchen API' : 'Web shop';

test('cards show the peer and link to a common anchor; the feed shows awaiting and answered', () => {
	expect(threadMessageCard(message, 'shop', title)).toEqual({ peer: 'kitchen', heading: 'You asked Kitchen API', status: 'Awaiting reply' });
	expect(threadMessageCard(message, 'kitchen', title)).toEqual({ peer: 'shop', heading: 'From Web shop', status: undefined });
	expect(threadMessageHref('bakery', 'sample', 'kitchen', message.id)).toEndWith('/threads/kitchen#peer-thread-message%3Aone');
	expect(threadMessageStatus({ ...message, replied: true })).toBe('Answered');
	expect(threadMessageStatus({ ...message, kind: 'note' })).toBeUndefined();
});

test('the log swaps the matching tool and receiver bubble for cards; old backends keep both legacy shapes', () => {
	const sender: EntryRecord = { id: 1, conversationId: 1, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', name: 'thread_send', id: 'one' }] }] };
	const receiver: EntryRecord = { id: 2, conversationId: 2, kind: 'pi.user', data: { threadMessageId: message.id }, model: [{ role: 'user', content: '[from shop] How many boxes?' }] };
	const options = { threadMessages: new Map([[message.id, message]]) };
	for (const entry of [sender, receiver]) expect(buildTranscript([entry], undefined, options)).toEqual([{ kind: 'threadMessage', key: message.id, message }]);
	expect(buildTranscript([sender], undefined)[0]?.kind).toBe('turn');
	expect(buildTranscript([receiver], undefined)[0]?.kind).toBe('thread');
});
