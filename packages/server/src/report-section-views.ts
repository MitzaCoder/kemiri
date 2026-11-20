import { REPORT_SECTION_VIEW_SECTIONS, ReportSectionViewSchema, type BoardTaskReport, type ReportSectionView, type ReportSectionViews } from "@kemiri/protocol";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ServerError } from "./errors.ts";
import type { ReportArtifactScope } from "./report-blocks.ts";

export const ReportSectionViewsInputSchema = Type.Object({
	results: Type.Optional(Type.Union([ReportSectionViewSchema, Type.Null()])),
	notDone: Type.Optional(Type.Union([ReportSectionViewSchema, Type.Null()])),
}, { additionalProperties: false, description: "write_report: attach a saved task HTML view (up to 256 KiB) to results or notDone with typed blocks. Pass null to detach; omission preserves only unchanged sections." });
export type ReportSectionViewsInput = Static<typeof ReportSectionViewsInputSchema>;

const MAX_SECTION_VIEW_BYTES = 256 * 1024;

export function validateSectionViewsInput(sectionViews: unknown, author: string): void {
	if (sectionViews === undefined) return;
	if (author !== "coordinator") throw new ServerError("bad_request", "Only a coordinator can change section views.");
	if (!Check(ReportSectionViewsInputSchema, sectionViews)) {
		throw new ServerError("bad_request", "Section views accept only results and notDone, each with an artifact ID, exact version and short label (up to 80 characters), or null.");
	}
}

const pinnedReference = (view: ReportSectionView) => `${view.artifactId}~${view.version}`;

async function retainedSectionViewArtifact(taskId: string, view: ReportSectionView, scope?: ReportArtifactScope) {
	if (!scope) return undefined;
	const artifact = await scope.store.get(scope.projectId, pinnedReference(view));
	if (artifact?.taskId !== taskId || artifact.projectId !== scope.projectId) return undefined;
	return await Bun.file(scope.store.filePath(artifact)).exists() ? artifact : undefined;
}

/** Check only explicit attachments. An omitted pointer can outlive its retained version. */
export async function validateSectionViewArtifacts(taskId: string, input?: ReportSectionViewsInput, scope?: ReportArtifactScope): Promise<void> {
	for (const section of REPORT_SECTION_VIEW_SECTIONS) {
		const view = input?.[section];
		if (!view) continue;
		const artifact = await retainedSectionViewArtifact(taskId, view, scope);
		if (!artifact) {
			throw new ServerError("bad_request", `Section view ${pinnedReference(view)} must name a retained artifact on this task in this project.`);
		}
		if (artifact.mimeType !== "text/html") throw new ServerError("bad_request", "Section views must be HTML artifacts.");
		if (artifact.size > MAX_SECTION_VIEW_BYTES) throw new ServerError("bad_request", "Section views can contain at most 256 KiB of source HTML.");
	}
}

export function sameSectionView(before?: ReportSectionView, after?: ReportSectionView): boolean {
	return before?.artifactId === after?.artifactId && before?.version === after?.version && before?.label === after?.label;
}

const sectionLabel = (section: (typeof REPORT_SECTION_VIEW_SECTIONS)[number]) => section === "results" ? "Results" : "Not done";

/** View changes belong to snapshot structure, not to the report's readable facts. */
export function diffReportSectionViews(before?: ReportSectionViews, after?: ReportSectionViews): string[] {
	return REPORT_SECTION_VIEW_SECTIONS.flatMap(section => {
		const older = before?.[section];
		const newer = after?.[section];
		if (sameSectionView(older, newer)) return [];
		return [`${sectionLabel(section)} view ${older ? (newer ? "replaced" : "detached") : "attached"}`];
	});
}

/** Resolve availability without reading source bytes or falling back to the latest file. */
export async function describeReportSectionViews(taskId: string, report: Pick<BoardTaskReport, "sectionViews">, scope?: ReportArtifactScope): Promise<string[]> {
	const lines = await Promise.all(REPORT_SECTION_VIEW_SECTIONS.map(async section => {
		const view = report.sectionViews?.[section];
		if (!view) return undefined;
		const available = await retainedSectionViewArtifact(taskId, view, scope) !== undefined;
		return `${sectionLabel(section)} view: ${JSON.stringify(view.label)} (${pinnedReference(view)})${available ? "" : " — View unavailable"}`;
	}));
	return lines.filter(line => line !== undefined);
}
