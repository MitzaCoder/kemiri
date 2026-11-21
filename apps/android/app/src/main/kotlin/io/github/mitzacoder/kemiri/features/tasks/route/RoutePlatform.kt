package io.github.mitzacoder.kemiri.features.tasks.route

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusTarget
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.chat.ArtifactThumb
import io.github.mitzacoder.kemiri.features.chat.ChatArtifactMetadata
import io.github.mitzacoder.kemiri.features.chat.artifactTitle
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.features.tasks.media.TaskFiles
import io.github.mitzacoder.kemiri.features.tasks.media.automaticReportProof
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.navigation.PanelTab
import io.github.mitzacoder.kemiri.protocol.Artifact
import io.github.mitzacoder.kemiri.protocol.BoardReportCheck
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.components.LucideIcon
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles

internal val RouteReplyGlyph = LucideIcon("message-circle", "M7.8 20.2a9 9 0 1 0-4-4L3 21l4.8-.8Z")
private val AheadGlyph = LucideIcon("arrow-right", "M5 12h14", "m12 5 7 7-7 7")

@Composable
internal fun RoutePlatform(sheet: TaskSheetState, door: RouteDoor, attention: RouteAttention, parts: List<BoardTask>, open: Boolean,
    wide: Boolean, onOpen: () -> Unit, onReply: () -> Unit, attentionFocus: FocusRequester, modifier: Modifier) {
    val colors = Jarvis.colors
    val raised = if (wide) open else door == RouteDoor.You && attention.count > 0
    val tone = when (door) { RouteDoor.You -> colors.warning; RouteDoor.Got -> colors.success; RouteDoor.Ahead -> colors.accent2 }
    val platform: @Composable () -> Unit = {
        Column(Modifier.fillMaxWidth().padding(if (raised) 14.dp else 0.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.size(22.dp).border(1.5.dp, tone, CircleShape), contentAlignment = Alignment.Center) {
                    LucideGlyph(when (door) { RouteDoor.You -> Lucide.CircleAlert; RouteDoor.Got -> Lucide.Check; RouteDoor.Ahead -> AheadGlyph },
                        size = 13.dp, tint = tone)
                }
                val focus = if (door == RouteDoor.You) Modifier.focusRequester(attentionFocus).focusTarget() else Modifier
                Text(door.label.uppercase(java.util.Locale.ROOT), Modifier.weight(1f).then(focus).semantics { heading() },
                    style = TaskType.xsSemibold, color = colors.fg)
                if (wide) RouteSmallButton(if (open) "Viewing" else "Open ›", onOpen, "Open ${door.label}", expanded = open)
                else if (door == RouteDoor.You && attention.count > 0) RouteQuiet("${attention.count} ${if (attention.count == 1) "thing waits" else "things wait"}")
            }
            HorizontalDivider(thickness = 1.5.dp, color = tone)
            when (door) {
                RouteDoor.You -> RouteYourStop(sheet, attention, open, wide, onReply)
                RouteDoor.Got -> RouteArrived(sheet, open, wide)
                RouteDoor.Ahead -> RouteAhead(sheet, parts, open, wide)
            }
        }
    }
    // Surface clips to its shape. Only the raised card has padding to clear rounded corners.
    Surface(modifier.fillMaxWidth().padding(top = if (wide && !raised) 14.dp else 0.dp),
        shape = if (raised) RoundedCornerShape(18.dp) else RectangleShape,
        color = if (raised) colors.surface else Color.Transparent, contentColor = colors.fg,
        shadowElevation = if (raised) 4.dp else 0.dp, border = if (raised) BorderStroke(1.dp, colors.border) else null) { platform() }
}

@Composable
private fun RouteYourStop(sheet: TaskSheetState, attention: RouteAttention, open: Boolean, wide: Boolean, onReply: () -> Unit) {
    val questions = sheet.needsYou.ownerQuestions.filterNot(::isWarning)
    val warnings = sheet.needsYou.ownerQuestions.filter(::isWarning)
    val shown = if (open) questions else questions.take(1)
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        shown.forEach { question -> key(question.id) {
            QuestionCard(sheet.context, question, askedBy = questionAskedBy(question, sheet.threads), compact = true, plain = true)
        } }
        if (attention.count == 0) RouteQuiet("Nothing waits for you.")
        else if (!open && attention.count > shown.size) {
            val more = attention.count - shown.size
            RouteQuiet("$more ${if (more == 1) "more thing waits" else "more things wait"}.")
        }
        if (open) {
            if (warnings.isNotEmpty()) RouteDisclosure("Heads-up", inline = wide) {
                warnings.forEach { warning -> key(warning.id) {
                    QuestionCard(sheet.context, warning, askedBy = questionAskedBy(warning, sheet.threads), compact = true, plain = true)
                } }
            }
            if (attention.steps) RouteDisclosure("Your steps", inline = true) { RouteReportSection(sheet, ReportSectionKind.Steps) }
            if (attention.review) {
                RouteDisclosure("Check the work", inline = true) {
                    if (sheet.nextPlacement == ReportNextPlacement.Review) RouteReportSection(sheet, ReportSectionKind.Next)
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { sheet.status.onSet("done", null, null) }, enabled = !sheet.status.saving) { Text("It works: close the task") }
                    OutlinedButton(onClick = onReply) { Text("Something is off…") }
                }
            }
            if (attention.blocked) RouteDisclosure("Blocked", inline = true) {
                sheet.task.blockedReason?.takeIf { it.isNotBlank() }?.let { ReportMarkdown(it) }
                sheet.blockers.forEach { blocker -> TaskFactLink(blocker.id, blocker.title, sheet.context::openTask) }
            }
            val record = sheet.record
            if (record.linksEnabled && (record.timeline?.feedback?.isNotEmpty() == true || openFeedbackCount(sheet.task) > 0 || record.problem != null)) {
                RouteDisclosure("Your notes", inline = wide) {
                    record.problem?.let {
                        Text(it, style = TaskType.xs, color = Jarvis.colors.danger)
                        RouteSmallButton("Retry", record.onRetryTimeline)
                    }
                    val timeline = record.timeline
                    if (timeline != null) TaskFeedback(timeline.feedback, record.feedbackBusy, sheet.now,
                        { threadName(it, sheet.threads) }, record.onSetFeedback)
                    else if (record.problem == null) RouteQuiet("Loading notes…")
                }
            }
        }
    }
}

@Composable
private fun RouteArrived(sheet: TaskSheetState, open: Boolean, wide: Boolean) {
    val colors = Jarvis.colors
    val report = sheet.task.report
    val resultsContent = remember(report) { routeResults(report) }
    val proof = remember(resultsContent, sheet.artifacts) { automaticReportProof(resultsContent, sheet.artifacts) }
    val results: @Composable () -> Unit = {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (open) {
                if (sheet.fields.showSummary) RouteReportSection(sheet, ReportSectionKind.Summary)
                if (sheet.staleReport) StaleTaskReport(sheet.context, sheet.task.id)
                if (resultsContent.hasContent) RouteReportSection(sheet, ReportSectionKind.Results)
            } else {
                val glance = remember(report, sheet.fields) { routeReportGlance(report, sheet.fields) }
                glance.firstOutcome?.let {
                    Text(it, style = TextStyles.base.copy(fontWeight = FontWeight.Bold), color = colors.fg,
                        maxLines = 4, overflow = TextOverflow.Ellipsis)
                }
                glance.findingTitles.take(3).forEach { RouteQuiet(it, maxLines = 3) }
            }
            if (!resultsContent.hasContent && !sheet.fields.showSummary) {
                RouteQuiet(if (emptyFinishedResults(sheet.task.status, report.results)) "No results yet · work finished" else "Nothing written yet.")
            }
            if (open) TaskUsageDisclosure(sheet.usage, sheet.task.id)
            else failedCheckLine(sheet.fields.checks)?.let { Text(it, style = TaskType.xs, color = colors.danger) }
        }
    }
    val evidence: @Composable () -> Unit = {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            sheet.artifactsProblem?.let { problem ->
                Text("Could not read files: $problem", style = TaskType.xs, color = colors.danger)
                RouteSmallButton("Retry files", sheet.onRetryArtifacts)
            }
            RouteProof(sheet, proof)
            RouteChecks(sheet.fields.checks, wide)
            io.github.mitzacoder.kemiri.features.apps.TaskApps(sheet.task.id)
            if (sheet.artifacts.isNotEmpty()) {
                TaskHeading("Files (${sheet.artifacts.size})")
                TaskFiles(sheet.context, sheet.artifacts, onUpdateTags = sheet.onUpdateArtifactTags)
            }
            sheet.record.delivery?.let { delivery ->
                RouteDisclosure("Delivery", inline = wide) { TaskDelivery(sheet.context, sheet.task, delivery, showHeading = false) }
            }
        }
    }
    if (!open) results()
    else BoxWithConstraints(Modifier.fillMaxWidth()) {
        if (wide && maxWidth >= 500.dp && (sheet.artifacts.isNotEmpty() || sheet.fields.checks.isNotEmpty() || sheet.record.delivery != null)) {
            Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                Column(Modifier.weight(1.3f)) { results() }
                Column(Modifier.weight(1f)) { evidence() }
            }
        } else Column(verticalArrangement = Arrangement.spacedBy(14.dp)) { results(); evidence() }
    }
}

@Composable
private fun RouteProof(sheet: TaskSheetState, proof: List<Artifact>) {
    if (proof.isEmpty()) return
    val shape = RoundedCornerShape(8.dp)
    TaskHeading("Proof")
    Row(Modifier.widthIn(max = 460.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        proof.forEach { artifact -> key(artifact.id) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val title = artifactTitle(artifact)
                Box(Modifier.fillMaxWidth().heightIn(min = 48.dp).aspectRatio(1.8f).clip(shape)
                    .border(1.dp, Jarvis.colors.borderStrong, shape).clickable(role = Role.Button, onClickLabel = "Open proof") {
                        ChatArtifactMetadata.keep(sheet.context.backend.config.key, artifact)
                        sheet.context.navigate(Destination.Artifact(sheet.context.route, artifact.id))
                    }.semantics { contentDescription = title }) {
                    ArtifactThumb(sheet.context, artifact, Modifier.fillMaxSize())
                }
                RouteQuiet(title, maxLines = 2)
            }
        } }
        if (proof.size == 1) Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun RouteChecks(checks: List<BoardReportCheck>, wide: Boolean) {
    if (checks.isEmpty()) return
    val colors = Jarvis.colors
    val passed = checks.filter { it.result == "passed" }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(7.dp), itemVerticalAlignment = Alignment.CenterVertically) {
        TaskHeading("Checks")
        Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            checks.sortedBy { it.result != "passed" }.take(12).forEach { check ->
                val tone = when (check.result) { "passed" -> colors.success; "failed" -> colors.danger; else -> colors.fgSubtle }
                Spacer(Modifier.size(6.dp).background(tone, CircleShape))
            }
        }
        RouteQuiet("${passed.size} of ${checks.size} passed")
    }
    checks.filter { it.result == "failed" }.forEach { check ->
        Text("${check.name} failed." + (check.note?.let { " $it" } ?: ""), style = TextStyles.sm, color = colors.danger)
    }
    if (passed.isNotEmpty()) RouteDisclosure("Passed checks", inline = wide) {
        passed.forEach { check -> RouteQuiet("✓ ${check.name}" + (check.count?.let { ": $it" } ?: "")) }
    }
}

@Composable
private fun RouteAhead(sheet: TaskSheetState, parts: List<BoardTask>, open: Boolean, wide: Boolean) {
    val task = sheet.task
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        val showNext = sheet.nextPlacement == ReportNextPlacement.Next
        val showNotDone = sheet.fields.showNotDone
        if (open) {
            if (showNotDone) {
                TaskHeading("Not done")
                RouteReportSection(sheet, ReportSectionKind.NotDone)
            }
            if (showNext) {
                TaskHeading("Next")
                RouteReportSection(sheet, ReportSectionKind.Next)
            }
        } else {
            val glance = remember(task.report, sheet.fields) { routeReportGlance(task.report, sheet.fields) }
            (glance.riskTitles + listOfNotNull(glance.legacyNotDone)).take(3).forEach { RouteQuiet(it, maxLines = 3) }
            if (showNext) glance.firstNextAction?.let {
                TaskHeading("Next")
                RouteQuiet(it, maxLines = 3)
            }
        }
        if (sheet.nextPlacement == null && !showNotDone) RouteQuiet("Nothing written yet.")
        if (open && sheet.needsYou.questionsForAgent.isNotEmpty()) RouteDisclosure("Waiting for an agent reply", inline = wide) {
            sheet.needsYou.questionsForAgent.forEach { question -> key(question.id) {
                QuestionCard(sheet.context, question, askedBy = questionAskedBy(question, sheet.threads), compact = true, plain = true)
            } }
        }
        if (parts.isNotEmpty()) RouteQuiet("${parts.count { it.status == "done" }} of ${parts.size} parts done")
        val haveConnections = parts.isNotEmpty() || task.parent != null || task.foundWhile != null || !task.ledTo.isNullOrEmpty() ||
            !task.related.isNullOrEmpty() || task.blockedBy.isNotEmpty() || !task.blocks.isNullOrEmpty() ||
            !task.subtasks.isNullOrEmpty() || task.workerIds.isNotEmpty() || sheet.owner.claimed
        if (open && haveConnections) RouteDisclosure("Parts, links and workers", inline = false) {
            TaskRelations(task, sheet.tasks, sheet.archivedLinks, if (task.status == "blocked") sheet.blockers.map { it.id }.toSet() else emptySet(),
                sheet.context::openTask) {
                sheet.context.board.showWithLinked(task.id)
                sheet.context.navigate(Destination.Panel(sheet.context.route, PanelTab.Board))
            }
            val ownerThreadId = sheet.owner.threadId
            if (ownerThreadId != null) RouteSmallButton("Owner: ${sheet.owner.label}", {
                sheet.context.navigate(sheet.context.route.copy(threadId = ownerThreadId.takeUnless(::isMainThread), workerId = null))
            }) else if (sheet.owner.claimed) RouteQuiet("Owner: ${sheet.owner.label}")
            if (task.workerIds.isNotEmpty()) TaskRecordWorkers(sheet.context, task.workerIds, sheet.workers)
        }
    }
}

@Composable
internal fun RouteRecord(sheet: TaskSheetState) {
    val record = sheet.record
    val task = sheet.task
    Column(Modifier.fillMaxWidth()) {
        HorizontalDivider(color = Jarvis.colors.border)
        RouteDisclosure("The record · Request and activity") {
            TaskRecord(task, sheet.decisions, sheet.fields.checks, sheet.now, record.folds, record.onFoldChange,
                record.decided, { threadName(it, sheet.threads) }, activityContent = if (record.linksEnabled ||
                    task.snapshots > 0 || task.workerIds.isNotEmpty() || record.now != null) { {
                    if (record.deliveryEnabled) {
                        val workersById = sheet.workers.associateBy { it.id }
                        val sources = ActivitySources(entries = record.timeline?.entries.orEmpty(), groups = record.timeline?.groups.takeIf { record.timelineGroupsEnabled },
                            questions = sheet.questions, decisions = record.decided.orEmpty(), feedback = record.timeline?.feedback.orEmpty(),
                            workers = task.workerIds.associateWith { workersById[it] }, now = record.now,
                            deliveryShown = record.delivery != null, taskLiveEnabled = sheet.liveEnabled)
                        TaskRecordActivity(sheet.context, task, sources, workersById,
                            record.linksEnabled && record.timeline == null && record.problem == null, record.problem,
                            record.timelineNewestFirst, record.onToggleTimelineOrder, sheet.now, record.writerName, sheet.liveNews)
                    } else {
                        if (record.linksEnabled) TaskTimeline(record.timeline?.entries.orEmpty(), record.timelineNewestFirst,
                            record.onToggleTimelineOrder, record.writerName, sheet.now,
                            groups = record.timeline?.groups.takeIf { record.timelineGroupsEnabled }, onKindsChanged = record.onTimelineKindsChanged)
                        if (task.snapshots > 0) TaskReadingSection("History") { TaskHistory(sheet.context, task, record.writerName) }
                        if (task.workerIds.isNotEmpty()) TaskRecordWorkers(sheet.context, task.workerIds, sheet.workers)
                    }
                } } else null)
        }
    }
}

@Composable
internal fun RouteQuiet(text: String, maxLines: Int = Int.MAX_VALUE) {
    Text(text, style = TextStyles.sm, color = Jarvis.colors.fgMuted, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
}

@Composable
internal fun RouteSmallButton(label: String, onClick: () -> Unit, description: String? = null, expanded: Boolean? = null) {
    val colors = Jarvis.colors
    Box(Modifier.heightIn(min = 44.dp).clip(RoundedCornerShape(50)).clickable(role = Role.Button, onClick = onClick)
        .semantics {
            if (description != null) contentDescription = description
            if (expanded != null) stateDescription = if (expanded) "Expanded" else "Collapsed"
        }, contentAlignment = Alignment.Center) {
        Text(label, Modifier.border(1.dp, if (expanded == true) colors.accent2.copy(alpha = .4f) else colors.borderStrong, RoundedCornerShape(50))
            .padding(horizontal = 8.dp, vertical = 5.dp), style = TaskType.xsSemibold, color = colors.fgMuted, maxLines = 1)
    }
}

@Composable
private fun RouteDisclosure(label: String, inline: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    var expanded by rememberSaveable(label) { mutableStateOf(false) }
    val colors = Jarvis.colors
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (inline) TaskHeading(label)
        else Row(Modifier.fillMaxWidth().heightIn(min = 46.dp).clickable(role = Role.Button) { expanded = !expanded }
            .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" },
            horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
            LucideGlyph(Lucide.ChevronRight, Modifier.rotate(if (expanded) 90f else 0f), size = 15.dp, tint = colors.fgMuted)
            Text(label, style = TextStyles.sm.copy(fontWeight = FontWeight.SemiBold), color = colors.fg)
        }
        if (inline || expanded) Column(verticalArrangement = Arrangement.spacedBy(7.dp), content = content)
    }
}
