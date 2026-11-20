import { markdownText, type ReportBlock } from '@kemiri/protocol';
import { Lexer, type Tokens } from 'marked';
import { readReportSection, type TaskReportSections } from './report-sections.js';

type Metric = Omit<Extract<ReportBlock, { kind: 'metric' }>, 'kind'>;

function firstLegacyLine(markdown: string): string | undefined {
	for (const token of Lexer.lex(markdown)) {
		const source = token.type === 'list' ? (token as Tokens.List).items[0]?.text :
			token.type === 'paragraph' || token.type === 'heading' ? token.raw : undefined;
		if (source) {
			const text = markdownText(source);
			if (text) return text;
		}
	}
}

/** Short reader-facing facts. Legacy prose can supply a lead or action, but does not imply typed metrics or titles. */
export function reportGlance({ report }: { report: TaskReportSections }, taskFieldsEnabled = true): {
	firstOutcome?: string;
	metrics: Metric[];
	findingTitles: string[];
	riskTitles: string[];
	legacyNotDone?: string;
	firstNextAction?: string;
} {
	const summary = readReportSection(taskFieldsEnabled ? report : {}, 'summary');
	const results = readReportSection(report, 'results');
	const notDone = readReportSection(taskFieldsEnabled ? report : {}, 'notDone');
	const next = readReportSection(report, 'next');
	const firstOutcome = (summary.kind === 'blocks' ? summary.blocks.find(block => block.kind === 'outcome')?.text : firstLegacyLine(summary.markdown))
		?? (results.kind === 'blocks' ? results.blocks.find(block => block.kind === 'outcome')?.text : firstLegacyLine(results.markdown));
	const firstNextAction = next.kind === 'blocks' ? next.blocks.find(block => block.kind === 'nextAction')?.text : firstLegacyLine(next.markdown);
	const resultBlocks = results.kind === 'blocks' ? results.blocks : [];
	const riskBlocks = notDone.kind === 'blocks' ? notDone.blocks : [];
	const legacyNotDone = notDone.kind === 'mirror' ? firstLegacyLine(notDone.markdown) : undefined;
	return {
		firstOutcome: firstOutcome && markdownText(firstOutcome),
		metrics: resultBlocks.flatMap(block => block.kind === 'metric' ? [{
			label: block.label, value: block.value, ...(block.unit === undefined ? {} : { unit: block.unit }),
			...(block.context === undefined ? {} : { context: markdownText(block.context) }),
		}] : []),
		findingTitles: resultBlocks.flatMap(block => block.kind === 'finding' ? [block.title] : []),
		riskTitles: [...resultBlocks, ...riskBlocks].flatMap(block => block.kind === 'risk' ? [block.title] : []),
		...(legacyNotDone ? { legacyNotDone } : {}),
		firstNextAction: firstNextAction && markdownText(firstNextAction),
	};
}
