import { ReportBlocksSchema, type Artifact, type BoardTaskReport, type ReportBlock, type ReportBlockSection } from '@kemiri/protocol';
import { Marked, type Tokens } from 'marked';
import { Check } from 'typebox/value';
import { artifactVersions } from './artifact-versions.js';
import { splitMedia } from './media-gallery.js';

export type TaskReportSections = Pick<BoardTaskReport, ReportBlockSection | 'blocks'>;
type ProofBlock = Extract<ReportBlock, { kind: 'proof' }>;

const markdown = new Marked({ gfm: true });
const rawHtml = /<!--|<![A-Z]|<\/?[a-z][a-z0-9-]*(?=[\s/>])/i;
const signedArtifactUrl = /(?:\/|%2f)artifacts(?:\/|%2f)[^\s]*?(?:\?|%3f)[^\s]*?\btoken(?:=|%3d)/i;

function isInlineProse(text: string): boolean {
	const tokens = markdown.lexer(text.trim());
	if (tokens.length !== 1 || tokens[0]?.type !== 'paragraph') return false;
	let safe = true;
	markdown.walkTokens(tokens, token => {
		if (['html', 'image', 'del'].includes(token.type)) safe = false;
		if (token.type === 'link' && !/^(?:https?:\/\/|mailto:)/i.test((token as Tokens.Link).href)) safe = false;
	});
	return safe;
}

function isRenderable(block: ReportBlock): boolean {
	if (block.kind === 'markdown') return true;
	if (signedArtifactUrl.test(JSON.stringify(block))) return false;
	if (block.kind === 'metric') {
		return Number.isFinite(block.value) && !rawHtml.test(block.label) && !rawHtml.test(block.unit ?? '') &&
			(block.context === undefined || isInlineProse(block.context));
	}
	if ('title' in block && rawHtml.test(block.title)) return false;
	if (block.kind === 'setup') return block.facts.every(({ label, value }) => !rawHtml.test(label) && !rawHtml.test(value));
	return isInlineProse(block.text);
}

/** Do not validate sibling sections: one newer section must not hide known sections. */
export function readReportSection(report: Partial<TaskReportSections>, section: ReportBlockSection) {
	const payload: unknown = report.blocks?.[section];
	if (Array.isArray(payload) && payload.length > 0 && Check(ReportBlocksSchema.properties[section], payload) && payload.every(isRenderable)) {
		return { kind: 'blocks', blocks: payload as readonly ReportBlock[] } as const;
	}
	return { kind: 'mirror', markdown: report[section] ?? '' } as const;
}

export function hasReportSection(report: Partial<TaskReportSections>, section: ReportBlockSection): boolean {
	const content = readReportSection(report, section);
	return content.kind === 'blocks' || Boolean(content.markdown.trim());
}

/** Even a newer Next with an unreadable block is for agents, not a manual review instruction. */
export function hasTypedNext(report: TaskReportSections): boolean {
	const next: unknown = report.blocks?.next;
	return next != null && (!Array.isArray(next) || next.length > 0);
}

export function automaticReportProof(report: TaskReportSections, artifacts: readonly Artifact[]): Artifact[] {
	const results = readReportSection(report, 'results');
	const cited = new Set(results.kind === 'blocks' ? results.blocks.flatMap(block => block.kind === 'proof' ? [block.artifactRef.artifactId] : []) : []);
	return splitMedia(artifacts).media.filter(artifact => !cited.has(artifact.id)).slice(0, 3);
}

/** A pinned version must never silently substitute latest. The feed is already project- and task-scoped. */
export function reportProofArtifact(block: ProofBlock, artifacts: readonly Artifact[]): Artifact | undefined {
	const { artifactId, version } = block.artifactRef;
	const artifact = artifacts.find(row => row.id === artifactId);
	if (version === undefined || artifact === undefined) return artifact;
	return artifactVersions(artifact).find(row => row.id === `${artifactId}~${version}`);
}

/** Group adjoining peers without sorting or splitting any authored text. */
export function reportBlockGroups(blocks: readonly ReportBlock[]) {
	const groups: { kind: ReportBlock['kind']; blocks: ReportBlock[] }[] = [];
	for (const block of blocks) {
		const previous = groups.at(-1);
		if (previous?.kind === block.kind && ['finding', 'risk', 'metric', 'step', 'nextAction'].includes(block.kind)) previous.blocks.push(block);
		else groups.push({ kind: block.kind, blocks: [block] });
	}
	return groups;
}
