package io.github.mitzacoder.kemiri.features.tasks.route

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.protocol.BoardTaskActivity
import io.github.mitzacoder.kemiri.protocol.BoardTaskLive
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.JetBrainsMono
import io.github.mitzacoder.kemiri.ui.theme.mix
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles
import kotlin.math.roundToInt

@Composable
internal fun RouteRail(sheet: TaskSheetState, stops: List<RouteStop>, live: BoardTaskLive?, liveNow: BoardTaskActivity?,
    wide: Boolean, gutter: Dp, onAttention: () -> Unit) {
    val current = stops.firstOrNull { it.state == RouteStopState.Now } ?: stops.firstOrNull { it.state == RouteStopState.Waits }
    val hasLive = live != null && liveNow != null
    var picked by rememberSaveable { mutableStateOf<String?>(null) }
    var expanded by rememberSaveable { mutableStateOf(false) }
    val selected = stops.firstOrNull { it.id == picked } ?: current
    val showingNow = selected != null && selected == current && hasLive
    val showCard = selected != null && (hasLive || selected.id == picked)
    val scroll = rememberScrollState()
    BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = if (wide) gutter else 0.dp)) {
        val stopWidth = maxOf(if (wide) 86.dp else 100.dp, maxWidth / stops.size.coerceAtLeast(1))
        val density = LocalDensity.current
        val selectedIndex = stops.indexOf(selected)
        LaunchedEffect(selected?.id, stops.size, maxWidth, scroll.maxValue) {
            if (selectedIndex >= 0 && scroll.maxValue != Int.MAX_VALUE) {
                val target = with(density) { (stopWidth.toPx() * (selectedIndex + .5f) - maxWidth.toPx() / 2).roundToInt() }
                scroll.scrollTo(target.coerceIn(0, scroll.maxValue))
            }
        }
        val card: @Composable () -> Unit = {
            if (showCard) {
                RouteLiveCard(sheet, selected, live.takeIf { showingNow }, liveNow.takeIf { showingNow },
                    expanded, { expanded = !expanded }, if (hasLive && !showingNow) ({ picked = null }) else null,
                    onAttention, Modifier.padding(horizontal = if (wide) 0.dp else gutter).widthIn(max = 420.dp).fillMaxWidth())
            }
        }
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (wide) card()
            Row(Modifier.fillMaxWidth().horizontalScroll(scroll).semantics { contentDescription = "Task route" }) {
                stops.forEachIndexed { index, stop -> key(stop.id) {
                    RouteStopMarker(stop, current == stop, selected == stop && showCard,
                        stops.getOrNull(index - 1), stops.getOrNull(index + 1), stopWidth) {
                        picked = if (hasLive || picked != stop.id) stop.id else null
                        if (stop.state == RouteStopState.Waits && !hasLive) onAttention()
                    }
                } }
            }
            if (!wide) card()
        }
    }
}

@Composable
private fun RouteStopMarker(stop: RouteStop, current: Boolean, selected: Boolean, previous: RouteStop?, next: RouteStop?, width: Dp, onClick: () -> Unit) {
    val colors = Jarvis.colors
    val tone = when (stop.state) {
        RouteStopState.Done, RouteStopState.Now -> colors.success
        RouteStopState.Waits -> colors.warning
        RouteStopState.Ahead -> colors.borderStrong
    }
    val qualifier = when (stop.state) {
        RouteStopState.Now -> "Now"
        RouteStopState.Waits -> "Waits for you"
        else -> null
    }
    val left = if (previous?.state == RouteStopState.Done && stop.state in listOf(RouteStopState.Done, RouteStopState.Now)) colors.success else colors.borderStrong
    val right = if (stop.state == RouteStopState.Done && next?.state in listOf(RouteStopState.Done, RouteStopState.Now)) colors.success else colors.borderStrong
    Column(Modifier.width(width).defaultMinSize(minHeight = 78.dp).drawBehind {
        val center = size.width / 2
        val y = 20.dp.toPx()
        val start = if (layoutDirection == androidx.compose.ui.unit.LayoutDirection.Ltr) 0f else size.width
        if (previous != null) drawLine(left, Offset(start, y), Offset(center, y), 2.dp.toPx())
        if (next != null) drawLine(right, Offset(center, y), Offset(size.width - start, y), 2.dp.toPx())
    }.clickable(role = Role.Button, onClick = onClick).semantics {
        stateDescription = listOfNotNull(qualifier ?: if (stop.state == RouteStopState.Done) "Completed" else "Ahead",
            "Selected".takeIf { selected }).joinToString(", ")
    }.padding(horizontal = 4.dp, vertical = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(28.dp).background(colors.bg, CircleShape)
            .then(if (stop.state == RouteStopState.Now || stop.state == RouteStopState.Waits) Modifier.border(2.dp, tone.copy(alpha = .38f), CircleShape) else Modifier),
            contentAlignment = Alignment.Center) {
            Box(Modifier.size(22.dp).background(if (stop.state == RouteStopState.Done) tone else colors.bg, CircleShape)
                .border(2.dp, tone, CircleShape), contentAlignment = Alignment.Center) {
                when (stop.state) {
                    RouteStopState.Done -> LucideGlyph(Lucide.Check, size = 13.dp, tint = colors.bg)
                    RouteStopState.Now -> Box(Modifier.size(9.dp).background(tone, CircleShape))
                    RouteStopState.Waits -> Text("!", color = tone, style = TaskType.xsSemibold)
                    RouteStopState.Ahead -> Unit
                }
            }
        }
        Text(stop.label, style = if (current || stop.state == RouteStopState.Waits) TaskType.xsSemibold else TaskType.xs,
            color = if (current || selected || stop.state == RouteStopState.Waits) colors.fg else colors.fgMuted,
            textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
        qualifier?.let { Text(it, style = TaskType.xsSemibold, color = tone, textAlign = TextAlign.Center) }
    }
}

@Composable
private fun RouteLiveCard(sheet: TaskSheetState, stop: RouteStop, live: BoardTaskLive?, now: BoardTaskActivity?, expanded: Boolean,
    onExpand: () -> Unit, onReset: (() -> Unit)?, onAttention: () -> Unit, modifier: Modifier) {
    val colors = Jarvis.colors
    Surface(modifier, shape = RoundedCornerShape(16.dp), color = colors.accent2.mix(colors.surface, if (colors.dark) 12f else 15f),
        shadowElevation = 3.dp, border = BorderStroke(1.dp, colors.border)) {
        Column(Modifier.padding(start = 14.dp, end = 12.dp, top = 6.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(when {
                    now != null -> "LIVE"
                    stop.state == RouteStopState.Done -> "COMPLETED STOP"
                    stop.state == RouteStopState.Waits -> "WAITS FOR YOU"
                    else -> "ON THE ROUTE"
                }, style = TaskType.xs.copy(fontFamily = JetBrainsMono), color = colors.fgMuted)
                (now?.since ?: stop.at)?.let { RouteQuiet(relativeTime(it, sheet.now)) }
                Spacer(Modifier.weight(1f))
                if (now != null && live != null) RouteSmallButton(if (expanded) "Less" else "So far", onExpand, expanded = expanded)
                else if (onReset != null) RouteSmallButton("Back to now", onReset)
            }
            TaskDetailText(now?.text ?: stop.label, style = TextStyles.base.copy(fontWeight = FontWeight.Bold), color = colors.fg)
            if (live != null && now != null) {
                live.pulse?.let { RouteQuiet("• ${it.label} · ${relativeTime(it.since, sheet.now)}") }
                if (expanded) {
                    val counters = liveCounterLabels(live.counters)
                    if (counters.isNotEmpty()) RouteQuiet(counters.joinToString(" · "))
                    val lines = visibleLiveLines(live.lines, watcher = sheet.liveNews != null).takeLast(3).asReversed()
                    if (lines.isEmpty() && counters.isEmpty()) RouteQuiet("No updates yet.")
                    lines.forEach { line -> key(line.id) { LiveLineRow(line, sheet.now, news = sheet.liveNews) } }
                }
            } else {
                if (stop.detail != stop.label) RouteQuiet(stop.detail)
                stop.taskId?.let { RouteSmallButton("Open linked task", { sheet.context.openTask(it) }) }
                if (stop.state == RouteStopState.Waits) RouteSmallButton("Go to Your stop", onAttention)
            }
        }
    }
}
