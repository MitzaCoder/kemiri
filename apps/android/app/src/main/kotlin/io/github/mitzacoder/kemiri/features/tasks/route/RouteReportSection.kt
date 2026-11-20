package io.github.mitzacoder.kemiri.features.tasks.route

import androidx.compose.runtime.Composable
import io.github.mitzacoder.kemiri.features.tasks.ReportSection
import io.github.mitzacoder.kemiri.features.tasks.ReportGlance
import io.github.mitzacoder.kemiri.features.tasks.TaskDetailFields
import io.github.mitzacoder.kemiri.features.tasks.reportGlance
import io.github.mitzacoder.kemiri.features.tasks.readReportSection
import io.github.mitzacoder.kemiri.protocol.BoardTaskReport
import io.github.mitzacoder.kemiri.features.tasks.ReportSectionKind
import io.github.mitzacoder.kemiri.features.tasks.TaskSheetState

/** Route owns headings and door placement, while the shared report owns the section body. */
@Composable
internal fun RouteReportSection(sheet: TaskSheetState, section: ReportSectionKind) {
    ReportSection(sheet.task, section, sheet.context, sheet.artifacts, sheet.sectionViewsSupported)
}

internal fun routeResults(report: BoardTaskReport) = readReportSection(report, ReportSectionKind.Results)

internal fun routeReportGlance(report: BoardTaskReport, fields: TaskDetailFields): ReportGlance =
    reportGlance(report, includeSummary = fields.showSummary, includeNotDone = fields.showNotDone)
