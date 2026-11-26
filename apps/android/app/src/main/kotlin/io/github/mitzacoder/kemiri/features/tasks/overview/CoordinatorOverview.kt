package io.github.mitzacoder.kemiri.features.tasks.overview

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.OverviewReader
import io.github.mitzacoder.kemiri.data.rememberProjectOverview
import io.github.mitzacoder.kemiri.features.coordinators.*
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.navigation.ChatHighlight
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.navigation.PanelTab
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import java.text.NumberFormat
import java.time.LocalDate
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.floor

@Composable
internal fun CoordinatorOverview(context: ProjectScreenContext) {
    val selector = LocalCoordinatorTaskScope.current
    val scope = if (selector == null) context.route.threadId ?: MAIN_THREAD_ID else selector.coordinator
    val read = rememberProjectOverview(context, true, scope, OverviewReader.Tasks)
    val snapshot = read.value
    if (snapshot == null) {
        Text(read.error?.let { "Could not load the overview. $it" } ?: "Loading overview…", Modifier.padding(16.dp), color = Jarvis.colors.fgMuted)
        return
    }
    val board by context.board.view.collectAsStateWithLifecycle()
    val tasks = remember(board.tasks) { board.tasks.associateBy { it.id } }
    val questions = remember(board.questions) { board.questions.associateBy { it.id } }
    val asOf = overviewTime(snapshot.asOf)
    val now = maxOf(rememberTaskMinuteNow(), asOf ?: 0)
    val elapsed = asOf?.let { now - it } ?: 0L
    val android = LocalContext.current
    val preferences = remember(android) { android.getSharedPreferences("coordinator-overview", Context.MODE_PRIVATE) }
    var more by remember(preferences) { mutableStateOf(preferences.getBoolean("more-numbers", false)) }
    val rollup = snapshot.coordinators
    val colors = Jarvis.colors
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = 14.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text(overviewOpening(snapshot.counts, now, rollup?.size ?: 0), Modifier.padding(horizontal = 2.dp, vertical = 2.dp),
                style = MaterialTheme.typography.titleLarge, color = colors.fg)
        }
        if (rollup != null) item {
            OverviewSection("All coordinators") {
                rollup.forEach { summary ->
                    val coordinator = selector?.roster?.find { it.id == summary.coordinatorId }
                    val title = coordinator?.title ?: if (summary.coordinatorId == MAIN_THREAD_ID) "General" else summary.coordinatorId
                    OverviewDivider()
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Button, onClickLabel = "Open coordinator overview") {
                        val route = coordinatorRoute(context.route, summary.coordinatorId)
                        setAllCoordinators(android, route, false)
                        if (route != context.route) context.navigate(Destination.Panel(route, PanelTab.Board))
                    }.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                        CoordinatorMark(coordinator, title)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(title, style = TaskType.rowTitle, color = colors.fg)
                            OverviewMeta(overviewRosterFacts(summary.counts))
                            summary.counts.oldestWaitSince?.let { since -> overviewAge(since, now)?.let { OverviewMeta("Oldest wait: $it") } }
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Text("${summary.week.requests} finished", style = TaskType.xsSemibold, color = colors.fg)
                            summary.week.taskUsage?.let { OverviewMeta(overviewMoney(it.apiValue)) }
                        }
                    }
                }
                OverviewDivider()
                Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text("Project", style = TaskType.rowTitle, color = colors.fg)
                    OverviewMeta("${overviewRosterFacts(snapshot.counts)} · ${snapshot.week.requests} finished")
                    OverviewMeta("Finished counts requests in the last 7 days.")
                }
            }
        } else {
            item {
                OverviewSection("Waiting on you", overviewCount(snapshot.waiting.size.toLong(), "thing"), waiting = true) {
                    if (snapshot.waiting.isEmpty()) OverviewNote("Nothing needs an answer or review.")
                    snapshot.waiting.sortedBy { it.since }.forEach { wait ->
                        val question = wait.questionId?.let(questions::get)
                        val task = wait.taskId?.let(tasks::get)
                        val request = wait.requestId?.let(tasks::get) ?: task
                        val title = when (wait.kind) {
                            "review" -> task?.let { "${it.title} is ready for review" } ?: "Ready for review"
                            "steps" -> task?.let { "Your steps for ${it.title}" } ?: "Your steps"
                            "warning" -> question?.text ?: "Warning"
                            else -> question?.text ?: "Open question"
                        }
                        val detail = listOfNotNull(request?.title.takeIf { question != null }, overviewAge(wait.since, now),
                            if (wait.holdsParts > 0) "holds ${overviewCount(wait.holdsParts, "part")}"
                            else "holds the request".takeIf { question != null && wait.requestId != null && wait.taskId == wait.requestId && (question.blocksWork ?: (wait.kind != "warning")) }).joinToString(" · ")
                        val click = when {
                            wait.taskId != null -> Modifier.clickable(role = Role.Button, onClickLabel = "Open waiting item") { context.openTask(wait.taskId, wait.questionId) }
                            wait.questionId != null -> Modifier.clickable(role = Role.Button, onClickLabel = "Open question") {
                                context.navigate(context.route.copy(highlight = ChatHighlight.Question(wait.questionId, now)))
                            }
                            else -> Modifier
                        }
                        OverviewDivider()
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).then(click).padding(horizontal = 12.dp, vertical = 10.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            val icon = when (wait.kind) { "review" -> Lucide.Check; "steps" -> TaskIcons.ListChecks; "warning" -> TaskIcons.TriangleAlert; else -> TaskIcons.CircleHelp }
                            Box(Modifier.size(24.dp).clip(RoundedCornerShape(6.dp)).background(colors.warning.copy(alpha = .12f)), contentAlignment = Alignment.Center) {
                                LucideGlyph(icon, size = 15.dp, tint = colors.warning)
                            }
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(title, style = TaskType.rowTitle, color = colors.fg)
                                if (detail.isNotBlank()) OverviewMeta(detail)
                            }
                        }
                    }
                    if (snapshot.more.heldUpTodayMs > 0) {
                        OverviewDivider()
                        OverviewNote("Requests spent ${overviewDuration(snapshot.more.heldUpTodayMs)} waiting today when no work was running.")
                    }
                }
            }
            item {
                val running = if (snapshot.counts.running > 0) " · ${snapshot.counts.running} running" else ""
                OverviewSection("In flight", overviewCount(snapshot.inFlight.size.toLong(), "request") + running) {
                    if (snapshot.inFlight.isEmpty()) OverviewNote("No open requests.")
                    overviewFlightOrder(snapshot.inFlight, tasks, elapsed).forEach { row ->
                        OverviewDivider()
                        FlightRow(row, tasks[row.requestId], elapsed) { context.openTask(row.requestId) }
                    }
                    if (snapshot.inFlight.any { it.left != null }) {
                        OverviewDivider()
                        OverviewNote("Estimates count agent work, not time waiting on you.")
                    }
                }
            }
        }
        item { OverviewWeek(snapshot.week) { context.navigate(Destination.Usage) } }
        item {
            Surface(shape = RoundedCornerShape(12.dp), color = colors.surface, border = androidx.compose.foundation.BorderStroke(1.dp, colors.border)) {
                Column {
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Button) {
                        more = !more
                        preferences.edit().putBoolean("more-numbers", more).apply()
                    }.semantics { stateDescription = if (more) "Expanded" else "Collapsed" }.padding(horizontal = 12.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        LucideGlyph(if (more) Lucide.ChevronDown else Lucide.ChevronRight, size = 16.dp, tint = colors.fgMuted)
                        Text("More numbers", style = TaskType.rowTitle, color = colors.fg)
                    }
                    if (more) MoreOverviewNumbers(snapshot)
                }
            }
        }
    }
}

@Composable private fun FlightRow(row: OverviewGetResponseInFlightItem, task: BoardTask?, elapsed: Long, open: () -> Unit) {
    val colors = Jarvis.colors
    Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Button, onClickLabel = "Open request", onClick = open)
        .padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(task?.title ?: row.requestId, style = TaskType.rowTitle, color = colors.fg)
        val parts = row.parts?.takeIf { it.total > 0 }
        if (parts != null) Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            task?.let(::taskPartProgress)?.let { TaskPartsBar(it) }
            OverviewMeta("${parts.done} of ${parts.total} parts done" + (if (parts.working > 0) " · ${parts.working} working" else "") +
                (if (parts.needsOwner > 0) " · ${parts.needsOwner} need you" else ""))
        }
        val sentence = task?.state?.sentence
        if (sentence != null && (parts == null || !sentence.text.startsWith("${parts.done} of ${parts.total} parts done"))) TaskActivityView(sentence, inlineAge = true)
        else if (sentence == null && task != null) OverviewMeta(taskStateLabel(task))
        row.planStep?.let { OverviewMeta("Step ${it.number} of ${it.total}: ${it.text}") }
        overviewEstimateLine(row.left, elapsed)?.let { estimate ->
            Spacer(Modifier.height(1.dp))
            Text(estimate.title, style = TaskType.xsSemibold, color = if (estimate.stopped) colors.warning else colors.fg)
            OverviewMeta(estimate.detail)
        }
    }
}

@Composable private fun OverviewWeek(week: OverviewGetResponseWeek, usage: () -> Unit) {
    val colors = Jarvis.colors
    val locale = LocalConfiguration.current.locales[0] ?: Locale.ROOT
    OverviewSection("Last 7 days") {
        Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val usual = week.usualWeek?.let { " A usual week is ${floor(it.low).toInt()} to ${ceil(it.high).toInt()} requests." }.orEmpty()
            Text("${overviewCount(week.requests, "request")} finished, with ${overviewCount(week.parts, "part")}.$usual", style = TaskType.rowTitle, color = colors.fg)
            week.startToDoneMs?.let { OverviewMeta("The usual request took ${overviewDuration(it)} from first work to done.") }
            if (week.sentBack > 0) OverviewMeta("${overviewCount(week.sentBack, "request")} went back to work after review.")
            week.taskUsage?.let {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) { OverviewMeta("Work was worth ${overviewMoney(it.apiValue)} at API prices.") }
                    TextButton(onClick = usage) { Text("Usage") }
                }
            }
            if (week.perDay.isNotEmpty() && (week.requests > 0 || week.parts > 0)) {
                val peak = week.perDay.maxOf { it.requests }.coerceAtLeast(1)
                Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    week.perDay.forEach { day ->
                        val name = runCatching { LocalDate.parse(day.day).dayOfWeek.getDisplayName(TextStyle.SHORT, locale) }.getOrDefault(day.day)
                        Column(Modifier.weight(1f).semantics(mergeDescendants = true) {
                            contentDescription = "$name: ${overviewCount(day.requests, "request")}, ${overviewCount(day.parts, "part")}"
                        }, horizontalAlignment = Alignment.CenterHorizontally) {
                            Box(Modifier.height(24.dp), contentAlignment = Alignment.BottomCenter) {
                                Box(Modifier.width(12.dp).height((24f * day.requests / peak).dp).background(colors.fgSubtle, RoundedCornerShape(topStart = 2.dp, topEnd = 2.dp)))
                            }
                            OverviewMeta(name)
                        }
                    }
                }
            }
            week.split?.let { split ->
                val slices = listOf(split.agentsMs to colors.fgMuted, split.waitingMs to colors.warning, split.otherMs to colors.border)
                val total = slices.sumOf { it.first }
                if (total > 0) {
                    Row(Modifier.fillMaxWidth().height(5.dp).clip(RoundedCornerShape(3.dp))) {
                        slices.filter { it.first > 0 }.forEach { (ms, color) -> Spacer(Modifier.weight((ms / total).toFloat()).fillMaxHeight().background(color)) }
                    }
                    OverviewMeta("Agents ${overviewDuration(split.agentsMs)} · Waiting on you ${overviewDuration(split.waitingMs)} · Other ${overviewDuration(split.otherMs)}")
                }
            }
        }
    }
}

@Composable private fun MoreOverviewNumbers(snapshot: OverviewEvent) {
    val more = snapshot.more
    val week = snapshot.week
    Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (more.estimates != null || more.estimateReplay != null) {
            OverviewFact("How the estimates did", listOfNotNull(
                more.estimates?.let { "The first range held for ${it.held} of ${overviewCount(it.scored, "finished request")}." },
                more.estimateReplay?.let { "In the historical replay, the first range held for ${it.held} of ${overviewCount(it.scored, "request")}." },
            ).joinToString("\n"))
        }
        more.reviews?.let { OverviewFact("Reviews", "Three in four ended within ${overviewDuration(it.p75Ms)} in the last 30 days.") }
        OverviewFact("Questions", "${more.questions.asked} asked and ${more.questions.answered} answered in the last 30 days." +
            more.questions.answerTime?.let { " Three in four answers came within ${overviewDuration(it.p75Ms)}." }.orEmpty())
        OverviewFact("Worker runs", "${more.runs.started} started, ${more.runs.failed} failed, and ${more.runs.stopped} stopped." +
            more.runs.medianMs?.let { " A typical run took ${overviewDuration(it)}." }.orEmpty() +
            if (more.runs.tasksWithMultipleRuns > 0) " ${overviewCount(more.runs.tasksWithMultipleRuns, "task")} had more than one run." else "")
        if (more.statusTimes.isNotEmpty()) OverviewFact("Typical time in each status", more.statusTimes.joinToString(" · ") {
            "${io.github.mitzacoder.kemiri.features.panels.boardStatusLabel(it.status)} ${overviewDuration(it.medianMs)}"
        })
        if (week.reopened > 0) OverviewFact("Reopened", "${overviewCount(week.reopened, "finished request")} reopened after being marked done.")
        if (more.checks.passed > 0 || more.checks.failed > 0) OverviewFact("Checks on open work", "${more.checks.passed} passed and ${more.checks.failed} failed.")
        more.modelRequests?.let { OverviewFact("Model requests", "${overviewCount(it.errors, "error")} and ${overviewCount(it.aborted, "abort")}.") }
        if (more.runningJobs.isNotEmpty() || more.nextSchedule != null) {
            val next = more.nextSchedule?.at?.let(::overviewTime)?.let { java.text.DateFormat.getDateTimeInstance().format(java.util.Date(it)) }
            OverviewFact("Jobs and schedules", "${overviewCount(more.runningJobs.size.toLong(), "job")} running." + (next?.let { " Next scheduled run: $it." } ?: ""))
        }
        more.deploys?.let { OverviewFact("Deploys", "${it.landed} landed, ${it.failed} failed, and ${it.rolledBack} rolled back.") }
        week.coordinatorUsage?.let { OverviewFact("Coordinator chat", "${overviewMoney(it.apiValue)} at API prices, counted separately.") }
    }
}

@Composable private fun OverviewSection(title: String, count: String? = null, waiting: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    val colors = Jarvis.colors
    Surface(shape = RoundedCornerShape(12.dp), color = if (waiting) colors.warning.copy(alpha = .045f) else colors.surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, if (waiting) colors.warning.copy(alpha = .32f) else colors.border)) {
        Column(Modifier.fillMaxWidth()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(title, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleSmall, color = colors.fg)
                count?.let { OverviewMeta(it) }
            }
            content()
        }
    }
}

@Composable private fun OverviewDivider() { HorizontalDivider(color = Jarvis.colors.border) }
@Composable private fun OverviewMeta(text: String) { Text(text, style = TaskType.xs, color = Jarvis.colors.fgMuted) }
@Composable private fun OverviewNote(text: String) { Box(Modifier.padding(horizontal = 12.dp, vertical = 9.dp)) { OverviewMeta(text) } }
@Composable private fun OverviewFact(title: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(title, style = TaskType.xsSemibold, color = Jarvis.colors.fg)
        OverviewMeta(value)
    }
}
private fun overviewMoney(value: Double) = NumberFormat.getCurrencyInstance(Locale.US).format(value)
