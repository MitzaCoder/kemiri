import { markdownText, type ReportBlock } from '@kemiri/protocol';
import { Marked, type Tokens } from 'marked';

const markdown = new Marked({ gfm: true });

/** Compare formatting-neutral prose, but do not collapse whitespace in exact instructions. */
export function markdownReportFacts(source: string): string {
	const code: string[] = [];
	markdown.walkTokens(markdown.lexer(source), token => {
		if (token.type === 'code' || token.type === 'codespan') code.push((token as Tokens.Code | Tokens.Codespan).text);
	});
	return JSON.stringify([markdownText(source), code]);
}

export type ReportStructureChanges = { added: number; removed: number; reordered: boolean };

function blockIdentity(block: ReportBlock): string {
	return JSON.stringify(block, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) : value);
}

/** Pair identical occurrences in order, so insertion and deletion alone never count as a reorder. */
export function reportStructureChanges(before: readonly ReportBlock[], after: readonly ReportBlock[]): ReportStructureChanges {
	const positions = new Map<string, number[]>();
	before.forEach((block, index) => {
		const identity = blockIdentity(block);
		const indices = positions.get(identity) ?? [];
		indices.push(index);
		positions.set(identity, indices);
	});
	const changes = { added: 0, removed: before.length, reordered: false };
	let latestPosition = -1;
	for (const block of after) {
		const position = positions.get(blockIdentity(block))?.shift();
		if (position === undefined) changes.added += 1;
		else {
			changes.removed -= 1;
			if (position < latestPosition) changes.reordered = true;
			latestPosition = Math.max(position, latestPosition);
		}
	}
	return changes;
}

/** Visible facts, not block kinds or artifact references. Keep procedure content exact. */
export function reportBlockFacts(block: ReportBlock): string[] {
	switch (block.kind) {
		case 'setup': return [block.title, ...block.facts.map(fact => `${fact.label}: ${fact.value}`)];
		case 'metric': return [`${block.label}: ${block.value}${block.unit ? ` ${block.unit}` : ''}${block.context ? ` — ${markdownText(block.context)}` : ''}`];
		case 'step': return [markdownText(block.text), ...(block.copyText === undefined ? [] : [block.copyText])];
		case 'finding': case 'risk': return [`${block.title}: ${markdownText(block.text)}`];
		case 'cleanup': return [`Cleaned up: ${markdownText(block.text)}`];
		default: return [markdownText(block.text)];
	}
}

/** Keep only genuinely unmatched facts; moves within a section never become additions. */
export function unmatchedReportFacts(facts: readonly string[], against: readonly string[]): string[] {
	const counts = new Map<string, number>();
	for (const fact of against) counts.set(fact, (counts.get(fact) ?? 0) + 1);
	return facts.filter(fact => {
		const count = counts.get(fact) ?? 0;
		if (count === 0) return true;
		counts.set(fact, count - 1);
		return false;
	});
}
