import type { BoardQuestion } from '@kemiri/protocol';

export function questionClarifySupported(features: readonly string[] | undefined): boolean {
	return features?.includes('question-clarify') ?? false;
}

export function canClarifyQuestion(question: BoardQuestion, enabled: boolean): boolean {
	return enabled && question.status === 'open' && !question.mcpApproval && !question.outsideModelApproval;
}

/** Highlighting is a hint, not automatic classification: Send still records an answer. */
export function highlightAskBack(text: string, enabled: boolean): boolean {
	return enabled && text.trimEnd().endsWith('?');
}

/** Retry the last clarification, never an agent's reply or the original decision question. */
export function askAgainText(question: BoardQuestion): string | undefined {
	return question.exchanges?.findLast(exchange => exchange.author.author === 'user')?.text;
}

export function questionNeedsAnswer(question: BoardQuestion): boolean {
	return question.status === 'open' && question.waitingOn !== 'agent';
}
