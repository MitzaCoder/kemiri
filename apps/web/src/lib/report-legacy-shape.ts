import { Lexer, type Token, type Tokens } from 'marked';
import type { ReportBlockSection } from '@kemiri/protocol';

export type LegacyReportSection = ReportBlockSection;
type LabeledRow = { label: string; value: string };
export type LegacyReportSegment =
	| { kind: 'markdown'; source: string }
	| { kind: 'rows'; items: string[] }
	| { kind: 'labeled'; rows: LabeledRow[] };

// Allow plain labels of up to four words and 32 characters. Only the first colon is a separator.
const labelPrefix = /^(\p{L}[\p{L}\p{M}\p{N}]*(?:[ \t]+[\p{L}\p{M}\p{N}]+){0,3}):[ \t]+(\S.*)$/u;

function labeledRow(line: string): LabeledRow | undefined {
	const match = labelPrefix.exec(line);
	if (!match || [...match[1]].length > 32 || match[2].startsWith('//')) return undefined;
	return { label: match[1], value: match[2] };
}

function shapeRows(items: string[]): LegacyReportSegment | undefined {
	const rows = items.flatMap(item => labeledRow(item) ?? []);
	if (items.length >= 2 && rows.length > 0) {
		// A partly labeled run is ambiguous. Keep its original Markdown, not a partial grid.
		return rows.length === items.length ? { kind: 'labeled', rows } : undefined;
	}
	return { kind: 'rows', items };
}

function flatBulletItems(list: Tokens.List): string[] | undefined {
	if (list.ordered || list.items.some(item => item.task || !item.text.trim() || item.tokens.length !== 1 ||
		!['text', 'paragraph'].includes(item.tokens[0].type))) return undefined;
	return list.items.map(item => item.text.trim());
}

function flatParagraphLines(paragraph: Tokens.Paragraph): string[] | undefined {
	// Hard breaks, inline HTML and inline Markdown spanning lines belong to the whole paragraph.
	if (paragraph.tokens.some(token => token.type !== 'text' &&
		(token.type === 'br' || token.type === 'html' || token.raw.includes('\n')))) return undefined;
	const lines = paragraph.text.split('\n');
	// A continuation indented beyond the first line is not a separate flat row.
	if (lines.some((line, index) => index > 0 && /^[ \t]/.test(line))) return undefined;
	return lines.map(line => line.trim());
}

function shapeBlock(token: Token, plainNotDone: boolean): LegacyReportSegment | undefined {
	if (token.type === 'list') {
		const items = flatBulletItems(token as Tokens.List);
		return items && shapeRows(items);
	}
	if (token.type !== 'paragraph') return undefined;
	const lines = flatParagraphLines(token as Tokens.Paragraph);
	if (!lines) return undefined;
	const shaped = shapeRows(lines);
	return plainNotDone || shaped?.kind === 'labeled' ? shaped : undefined;
}

/** Read-time layout only. Markdown that is not shaped stays in the ordinary renderer. */
export function shapeLegacyReport(section: LegacyReportSection, source: string): LegacyReportSegment[] {
	if (!source.trim()) return [];
	const markdown: LegacyReportSegment[] = [{ kind: 'markdown', source }];
	if (section === 'summary' || section === 'steps') return markdown;
	const normalized = source.replace(/\r\n?/g, '\n');
	const tokens = Lexer.lex(normalized, { gfm: true });
	// Reference definitions can be used by other blocks. Never separate them from their users.
	if (Object.keys(tokens.links).length || tokens.map(token => token.raw).join('') !== normalized) return markdown;

	const blocks = tokens.filter(token => token.type !== 'space');
	const plainNotDone = section === 'notDone' && blocks.length === 1 && blocks[0].type === 'paragraph';
	if (section === 'notDone' && !plainNotDone && !blocks.every(token => token.type === 'list' && flatBulletItems(token as Tokens.List))) {
		return markdown;
	}

	const segments: LegacyReportSegment[] = [];
	let markdownSource = '';
	function flushMarkdown() {
		if (markdownSource.trim()) segments.push({ kind: 'markdown', source: markdownSource });
		markdownSource = '';
	}
	for (const token of tokens) {
		const shaped = shapeBlock(token, plainNotDone);
		if (shaped) {
			flushMarkdown();
			segments.push(shaped);
		} else {
			markdownSource += token.raw;
		}
	}
	flushMarkdown();
	return segments.some(segment => segment.kind !== 'markdown') ? segments : markdown;
}
