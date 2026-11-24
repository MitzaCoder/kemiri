package io.github.mitzacoder.kemiri.features.tasks

import android.content.Context
import androidx.core.content.edit
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.github.mitzacoder.kemiri.protocol.BoardLiveLine
import io.github.mitzacoder.kemiri.protocol.BoardTaskActivity
import io.github.mitzacoder.kemiri.protocol.BoardTaskLive
import io.github.mitzacoder.kemiri.protocol.BoardTaskLivePulse
import io.github.mitzacoder.kemiri.protocol.WorkerSummary
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles
import kotlinx.coroutines.delay
import java.time.Instant

private const val LIVE_SEEN_PREFERENCES = "aiki.task-live-seen.v1"

private class PreferencesLiveSeenStore(context: Context) : LiveSeenStore {
    private val preferences = context.applicationContext.getSharedPreferences(LIVE_SEEN_PREFERENCES, Context.MODE_PRIVATE)
    override fun read(key: String): String? = preferences.getString(key, null)
    override fun write(key: String, value: String) { preferences.edit { putString(key, value) } }
}

/** True while the app is on screen: the checkpoint and pulse clock only advance while shown. */
@Composable
private fun rememberShown(): Boolean {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var shown by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) }
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, _ -> shown = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    return shown
}

/**
 * What a working task is doing now and how it got there (web `TaskLive.svelte`): Now, the newest three lines, the rest
 * under Earlier, and a divider where this visit's unseen lines end. [backendKey], [projectId] and [taskId] name the
 * device-local checkpoint.
 */
@Composable
internal fun TaskLive(
    live: BoardTaskLive, now: BoardTaskActivity, backendKey: String, projectId: String, taskId: String,
    news: LiveNewsActions?, workers: List<WorkerSummary>, onOpenTranscript: (WorkerSummary) -> Unit,
) {
    val colors = Jarvis.colors
    val minute = rememberTaskMinuteNow()
    val context = LocalContext.current
    val shown = rememberShown()
    val key = remember(backendKey, projectId, taskId) { liveSeenKey(backendKey, projectId, taskId) }
    val watcher = news != null
    val chronological = remember(live.lines, watcher) { visibleLiveLines(live.lines, watcher) }
    val counters = remember(live.counters) { liveCounterLabels(live.counters) }
    // A visit starts when the sheet becomes visible and keeps its divider until it is hidden or the task changes.
    val visit = remember(key, shown) { if (shown) LiveTrailVisit(PreferencesLiveSeenStore(context), key) else null }
    val visitState = remember(visit, chronological) { visit?.update(chronological) ?: LiveVisitState(emptySet(), emptySet()) }
    val trail = remember(chronological, now.text, visitState, watcher) { liveTrail(chronological, now.text, visitState.unseenIds, watcher) }
    var earlierOpen by rememberSaveable(taskId) { mutableStateOf(false) }

    val (nowWorker, transcriptWorkers) = remember(taskId, now, workers) { liveTranscriptWorkers(taskId, now, workers) }
    TaskReadingSection(null) {
        if (transcriptWorkers.isEmpty()) TaskHeading("Live")
        else FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, itemVerticalAlignment = Alignment.CenterVertically) {
            TaskHeading("Live")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                transcriptWorkers.forEach { worker ->
                    TextButton(onClick = { onOpenTranscript(worker) }, modifier = Modifier.heightIn(min = 48.dp).semantics {
                        contentDescription = "Transcript for ${worker.id}"
                    }) {
                        Text(if (transcriptWorkers.size == 1) "Transcript" else "Transcript · ${worker.id}", style = TaskType.xs, color = colors.fg,
                            textDecoration = TextDecoration.Underline)
                    }
                }
            }
        }
        val age = relativeTime(now.since, minute)
        val nowSemantics = if (nowWorker != null) Modifier else Modifier.semantics(mergeDescendants = true) {
            contentDescription = liveNowDescription(now, age)
        }
        Row(Modifier.fillMaxWidth().then(nowSemantics),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
            Text("Now", Modifier.alignByBaseline(), style = TaskType.xsSemibold, color = colors.fgMuted)
            val sentence = buildAnnotatedString {
                if (nowWorker == null) append(now.text)
                else {
                    val link = LinkAnnotation.Clickable("worker:${nowWorker.id}", TextLinkStyles(SpanStyle(textDecoration = TextDecoration.Underline))) {
                        onOpenTranscript(nowWorker)
                    }
                    withLink(link) { append(nowWorker.id) }
                    append(now.text.substring(nowWorker.id.length))
                }
            }
            TaskDetailText(sentence, Modifier.weight(1f).alignByBaseline(), style = TextStyles.sm, color = colors.fg)
            Text(age, Modifier.alignByBaseline(), style = TaskType.xs, color = colors.fgMuted)
        }
        live.pulse?.let { LivePulse(it, shown) }
        if (counters.isNotEmpty()) LiveCounters(counters)
        live.plan?.let { steps -> key(key) { TaskLivePlan(steps, foldOnPhone = true) } }
        if (trail.newest.isNotEmpty()) {
            TaskHeading("So far")
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                trail.newest.forEach { item -> LiveTrailEntry(item, minute, visitState.arrived, news) }
            }
            if (trail.earlierLines > 0) {
                val summary = "Earlier · ${trail.earlierLines}" + if (trail.earlierUnseen > 0) " · ${trail.earlierUnseen} new" else ""
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Button) { earlierOpen = !earlierOpen }
                        .semantics { contentDescription = summary; stateDescription = if (earlierOpen) "Expanded" else "Collapsed" },
                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    LucideGlyph(Lucide.ChevronRight, Modifier.rotate(if (earlierOpen) 90f else 0f), size = 16.dp, tint = colors.fgMuted)
                    Text(summary, style = TaskType.xs, color = colors.fgMuted)
                }
                if (earlierOpen) Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    trail.earlier.forEach { item -> LiveTrailEntry(item, minute, emptySet(), news) }
                }
            }
        }
    }
}

@Composable
private fun LivePulse(pulse: BoardTaskLivePulse, shown: Boolean) {
    val colors = Jarvis.colors
    val elapsed by produceState(pulseElapsed(pulse.since, Instant.now()), pulse.since, shown) {
        if (shown) {
            while (true) {
                value = pulseElapsed(pulse.since, Instant.now())
                delay(1000)
            }
        }
    }
    Row(
        Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = livePulseDescription(pulse, elapsed) },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.padding(top = 7.dp).size(6.dp).background(colors.fg, CircleShape))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically) {
            Text(pulse.label, style = TextStyles.sm, color = colors.fg)
            pulse.tool?.let { Text("· $it", style = TaskType.xs, color = colors.fgMuted) }
            elapsed?.let { Text("· $it", style = TaskType.xs, color = colors.fgMuted) }
        }
    }
}

@Composable
private fun LiveCounters(counters: List<String>) {
    FlowRow(
        Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = "Run counters: " + counters.joinToString(", ") },
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        counters.forEach { Text(it, style = TaskType.xs, color = Jarvis.colors.fgMuted) }
    }
}

@Composable
private fun LiveTrailEntry(item: LiveTrailItem, minute: Long, arrived: Set<String>, news: LiveNewsActions?) = when (item) {
    is LiveTrailItem.Line -> key(item.line.id) { LiveLineRow(item.line, minute, arrived = item.line.id in arrived, news = news) }
    LiveTrailItem.Divider -> LiveDivider()
}

@Composable
private fun LiveDivider() {
    val colors = Jarvis.colors
    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp).semantics(mergeDescendants = true) { contentDescription = LIVE_DIVIDER_DESCRIPTION },
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = colors.border)
        Text(LIVE_DIVIDER_LABEL, style = TaskType.xs, color = colors.fgMuted)
        HorizontalDivider(Modifier.weight(1f), color = colors.border)
    }
}

/**
 * Facts have a dashed rail, phases a quiet solid rail and results a success rail. A line that just arrived
 * is softly highlighted once, unless the system animations are off.
 */
@Composable
internal fun LiveLineRow(line: BoardLiveLine, minute: Long, arrived: Boolean = false, news: LiveNewsActions?) {
    val colors = Jarvis.colors
    val kind = LiveLineKind.fromWire(line.kind, watcher = news != null) ?: return
    val auto = remember(line, kind) { autoLinePresentation(kind, line) }
    val reduced = rememberReducedMotion()
    val highlight = remember { Animatable(if (arrived && !reduced) 1f else 0f) }
    LaunchedEffect(Unit) { if (highlight.value > 0f) highlight.animateTo(0f, tween(1400)) }
    val railColor = when (kind) {
        LiveLineKind.Phase, LiveLineKind.Auto -> colors.border
        LiveLineKind.Result -> colors.success
        LiveLineKind.Fact -> colors.fgMuted
    }
    val age = relativeTime(line.at, minute)
    Column(
        Modifier.fillMaxWidth()
            .drawBehind { drawRect(colors.surface2.copy(alpha = highlight.value)) }
            .drawBehind {
                val x = if (layoutDirection == LayoutDirection.Ltr) 1.dp.toPx() else size.width - 1.dp.toPx()
                val dash = when (kind) {
                    LiveLineKind.Fact -> PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))
                    LiveLineKind.Auto -> PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 3.dp.toPx()))
                    else -> null
                }
                drawLine(railColor, Offset(x, 0f), Offset(x, size.height), strokeWidth = 2.dp.toPx(), pathEffect = dash)
            }
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        val description = liveLineDescription(kind, line, age)
        val summary: @Composable (Boolean?) -> Unit = { expanded ->
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                if (expanded != null) LucideGlyph(Lucide.ChevronRight, Modifier.rotate(if (expanded) 90f else 0f), size = 14.dp, tint = colors.fgMuted)
                Text(auto?.mark ?: kind.label, style = TaskType.xsSemibold, color = if (kind == LiveLineKind.Result) colors.fg else colors.fgMuted)
                Text(line.actor.name, style = TaskType.xs, color = colors.fgMuted)
                Text(age, style = TaskType.xs, color = colors.fgMuted)
                auto?.wrongLabel?.let { Text(it, style = TaskType.xs, color = colors.fgMuted) }
            }
            if (auto != null) {
                Text(line.text, style = TextStyles.sm, color = colors.fgMuted,
                    textDecoration = if (auto.struckThrough) TextDecoration.LineThrough else null)
            } else {
                TaskDetailText(line.text, style = if (kind == LiveLineKind.Result) TextStyles.sm.copy(fontWeight = FontWeight.Medium) else TextStyles.sm,
                    color = if (kind == LiveLineKind.Phase) colors.fgMuted else colors.fg)
            }
        }
        if (auto != null && news != null) LiveAutoLine(line, auto, description, news) { expanded -> summary(expanded) }
        else Column(Modifier.semantics(mergeDescendants = true) { contentDescription = description }, verticalArrangement = Arrangement.spacedBy(2.dp)) { summary(null) }
    }
}
