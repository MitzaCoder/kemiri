import type { ThreadMessage, ThreadSummary } from '@kemiri/protocol';
import { coordinatorHref } from './coordinators.ts';

export function threadMessageId(data: unknown): string | undefined {
	const id = (data as { threadMessageId?: unknown } | null)?.threadMessageId;
	return typeof id === 'string' ? id : undefined;
}

export function threadMessageAnchor(id: string): string { return `peer-${encodeURIComponent(id)}`; }
export function threadMessageHref(backend: string, project: string, thread: string, id: string): string {
	return `${coordinatorHref(backend, project, thread)}#${threadMessageAnchor(id)}`;
}

export function threadMessageStatus(message: ThreadMessage): string | undefined {
	return message.kind === 'request' && message.awaitReply ? message.replied ? 'Answered' : 'Awaiting reply' : undefined;
}

export function threadMessageCard(message: ThreadMessage, viewing: string, title: (id: string) => string) {
	const sent = viewing === message.from;
	const peer = sent ? message.to : message.from;
	const verb = message.kind === 'request' ? 'You asked' : message.kind === 'reply' ? 'You replied to' : 'You left a note for';
	return { peer, heading: `${sent ? verb : 'From'} ${title(peer)}`, status: sent ? threadMessageStatus(message) : undefined };
}

export type ThreadMessageLinks = {
	thread: (id: string) => ThreadSummary | undefined;
	chat: (thread: string, message: string) => string;
	task: (id: string) => string;
};
