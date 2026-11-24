import type { Answer, AnswerWork, BoardTask, HarnessFeature, TaskAnswerQuestion } from '@kemiri/protocol';
import type { HarnessClient } from '@kemiri/client';

export function answersSupported(features: readonly (HarnessFeature | string)[] | undefined): boolean {
	return features?.includes('answers') === true;
}

export function answersWorkAndTasksSupported(features: readonly (HarnessFeature | string)[] | undefined): boolean {
	return answersSupported(features) && features?.includes('answers-work-and-tasks') === true;
}

export function canCopyToAnswers(task: Pick<BoardTask, 'parent' | 'status'>, supported: boolean): boolean {
	return supported && !task.parent && (task.status === 'done' || task.status === 'dropped');
}

export function answerWorkLabel(work: AnswerWork, at: string, now: number): string {
	const state = work.status === 'failed' ? 'Worker failed' : work.status === 'stopped' ? 'Worker stopped' :
		work.status === 'awaiting_reply' ? 'Awaiting reply' : work.status === 'unavailable' ? 'Worker unavailable' : 'Working';
	const minutes = state === 'Working' ? Math.max(work.elapsedMinutes ?? 0, Math.floor((now - Date.parse(at)) / 60_000)) : undefined;
	return [state, work.workerId, minutes === undefined ? undefined : `${minutes} min`].filter(Boolean).join(' · ');
}

export type TaskQuestionRow = TaskAnswerQuestion & { id: string; title: string; pinned: false };
export function taskQuestionRow(question: TaskAnswerQuestion): TaskQuestionRow {
	return { ...question, id: question.feedbackId, title: question.question.trim().split(/\r?\n/, 1)[0]!, pinned: false };
}

export function answerFromUrl(url: { searchParams: Pick<URLSearchParams, 'get'> }): string | undefined {
	const id = url.searchParams.get('answer');
	return id && /^A[1-9]\d*$/.test(id) ? id : undefined;
}

export function groupAnswers<Row extends Pick<Answer, 'id' | 'at' | 'pinned'>>(answers: readonly Row[], now: number): { day: string; answers: Row[] }[] {
	const groups = new Map<string, Row[]>();
	for (const answer of [...answers].sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
		b.at.localeCompare(a.at) || Number(b.id.slice(1)) - Number(a.id.slice(1)))) {
		const day = answer.pinned ? 'Pinned' : answerDay(answer.at, now);
		const group = groups.get(day);
		if (group) group.push(answer);
		else groups.set(day, [answer]);
	}
	return [...groups].map(([day, answers]) => ({ day, answers }));
}

export function answerDay(at: string, now: number): string {
	const date = new Date(at);
	const today = new Date(now);
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (date.toDateString() === today.toDateString()) return 'Today';
	if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
	return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

export function answerPreview(markdown: string): string {
	return markdown.trim().replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/(\*\*|__|`)(.*?)\1/g, '$2').replace(/\s+/g, ' ');
}

export function answerTime(at: string): string {
	return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at));
}

export function answerWhen(at: string, now: number): string {
	const day = answerDay(at, now);
	return `${day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : day} ${answerTime(at)}`;
}

export function hasUnreadAnswers(answers: readonly Answer[]): boolean {
	return answers.some(answer => !answer.working && !answer.read);
}

/** Entry IDs are local to a coordinator's transcript. Earlier replies still link to the same answer. */
export function answersByReply(answers: readonly Answer[], coordinatorId: string): Map<number, string> {
	const ids = new Map<number, string>();
	for (const answer of answers) for (const exchange of [answer, ...answer.exchanges]) {
		if (exchange.coordinatorId === coordinatorId && exchange.entryId !== undefined) ids.set(exchange.entryId, answer.id);
	}
	return ids;
}

export function answerRequests(client: Pick<HarnessClient, 'request'>, projectId: string) {
	return {
		async list(query?: string, subscribe?: boolean): Promise<{ answers: Answer[]; taskQuestions: TaskAnswerQuestion[] }> {
			const reply = await client.request({ type: 'answers.list', projectId, query: query?.trim() || undefined, subscribe });
			if (reply.type !== 'answers.list') throw unexpectedReply(reply);
			return { answers: reply.answers, taskQuestions: reply.taskQuestions ?? [] };
		},
		async update(answerId: string, fields: { pinned?: boolean; read?: boolean }): Promise<Answer> {
			const reply = await client.request({ type: 'answers.update', projectId, answerId, ...fields });
			if (reply.type !== 'answers.update') throw unexpectedReply(reply);
			return reply.answer;
		},
		async ask(answerId: string, requestId: string, question?: string): Promise<void> {
			const reply = await client.request({ type: 'answers.ask', projectId, answerId, requestId, question });
			if (reply.type !== 'answers.ask') throw unexpectedReply(reply);
		},
		async turnIntoTask(answerId: string): Promise<string> {
			const reply = await client.request({ type: 'answers.turnIntoTask', projectId, answerId });
			if (reply.type !== 'answers.turnIntoTask') throw unexpectedReply(reply);
			return reply.taskId;
		},
		async copyFromTask(taskId: string): Promise<string> {
			const reply = await client.request({ type: 'answers.copyFromTask', projectId, taskId });
			if (reply.type !== 'answers.copyFromTask') throw unexpectedReply(reply);
			return reply.answerId;
		},
		async delete(answerId: string): Promise<void> {
			const reply = await client.request({ type: 'answers.delete', projectId, answerId });
			if (reply.type !== 'answers.delete') throw unexpectedReply(reply);
		},
	};
}

function unexpectedReply(reply: { type: string; error?: { message: string } }): Error {
	return new Error(reply.error?.message ?? 'Unexpected reply from the backend.');
}
