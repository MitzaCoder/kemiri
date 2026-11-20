package io.github.mitzacoder.kemiri.features.tasks.route

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.features.refs.refLinkedText
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles
import kotlinx.coroutines.launch

@Composable
internal fun RouteTaskView(sheet: TaskSheetState) {
    val colors = Jarvis.colors
    val task = sheet.task
    val attention = routeAttention(task, sheet.needsYou)
    val parts = remember(task, sheet.tasks) { routeParts(task, sheet.tasks) }
    val live = task.live.takeIf { sheet.liveEnabled }
    val liveNow = routeLiveNow(task, live, sheet.liveNow ?: sheet.activity)
    val stops = remember(task, parts, attention, liveNow?.since, sheet.now) { routeStops(task, parts, attention, liveNow?.since, sheet.now) }
    var chosenDoor by rememberSaveable { mutableStateOf<RouteDoor?>(null) }
    val openDoor = chosenDoor ?: defaultRouteDoor(attention.count)
    var replyOpen by rememberSaveable { mutableStateOf(false) }
    var focusReply by remember { mutableStateOf(false) }
    val attentionPosition = remember { BringIntoViewRequester() }
    val attentionFocus = remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    val openAttention: () -> Unit = {
        chosenDoor = RouteDoor.You
        scope.launch { attentionPosition.bringIntoView(); attentionFocus.requestFocus() }
    }
    val openReply: () -> Unit = { replyOpen = true; focusReply = true }
    Column(Modifier.fillMaxSize().windowInsetsPadding(taskSheetInsets(false)).imePadding()) {
        RouteTopBar(sheet)
        HorizontalDivider(color = colors.border)
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val wide = maxWidth >= ROUTE_DOORS_MIN_WIDTH.dp
            val gutter = if (wide) 28.dp else 16.dp
            val reducedMotion = rememberReducedMotion()
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
                Column(Modifier.widthIn(max = 1520.dp).fillMaxWidth().padding(top = 10.dp, bottom = 78.dp),
                    verticalArrangement = Arrangement.spacedBy(if (wide) 24.dp else 18.dp)) {
                    RouteHero(sheet, attention, wide, openAttention, Modifier.padding(horizontal = gutter))
                    if (sheet.editing) TaskEditor(sheet.context, task, sheet.tasks, onBack = { sheet.onEditChange(false) }, scrolls = false,
                        modifier = Modifier.padding(horizontal = gutter))
                    else {
                        RouteRail(sheet, stops, live, liveNow, wide, gutter, openAttention)
                        val attentionModifier = Modifier.bringIntoViewRequester(attentionPosition)
                        if (wide) {
                            Row(Modifier.fillMaxWidth().padding(horizontal = gutter), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                RouteDoor.entries.forEach { door -> key(door) {
                                    val opened = door == openDoor
                                    val weight by animateFloatAsState(if (opened) 3.4f else 1f,
                                        if (reducedMotion) snap() else tween(230), label = "${door.label} width")
                                    RoutePlatform(sheet, door, attention, parts, opened, wide = true,
                                        onOpen = { chosenDoor = door }, onReply = openReply, attentionFocus = attentionFocus,
                                        modifier = Modifier.weight(weight).then(if (door == RouteDoor.You) attentionModifier else Modifier))
                                } }
                            }
                        } else Column(Modifier.fillMaxWidth().padding(horizontal = gutter), verticalArrangement = Arrangement.spacedBy(22.dp)) {
                            RouteDoor.entries.forEach { door -> key(door) {
                                RoutePlatform(sheet, door, attention, parts, open = true, wide = false,
                                    onOpen = {}, onReply = openReply, attentionFocus = attentionFocus,
                                    modifier = if (door == RouteDoor.You) attentionModifier else Modifier)
                            } }
                        }
                        Box(Modifier.padding(horizontal = gutter)) { RouteRecord(sheet) }
                    }
                }
            }
            if (!replyOpen && !sheet.editing) {
                Surface(onClick = openReply, modifier = Modifier.align(Alignment.BottomEnd).padding(end = gutter, bottom = 10.dp),
                    shape = RoundedCornerShape(50), color = colors.surface, contentColor = colors.fg,
                    border = BorderStroke(1.dp, colors.borderStrong), shadowElevation = 5.dp) {
                    Row(Modifier.heightIn(min = 48.dp).padding(horizontal = 17.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        LucideGlyph(RouteReplyGlyph, size = 16.dp)
                        Text("Reply", style = TextStyles.sm.copy(fontWeight = FontWeight.Bold))
                    }
                }
            }
        }
        val reply = sheet.reply
        if (replyOpen && reply != null) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.BottomEnd) {
                Surface(Modifier.widthIn(max = 520.dp).fillMaxWidth().padding(horizontal = 12.dp),
                    shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp),
                    color = colors.surface, border = BorderStroke(1.dp, colors.border), shadowElevation = 5.dp) {
                    Column {
                        Row(Modifier.fillMaxWidth().padding(start = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("Reply about ${task.id}", Modifier.weight(1f), style = TextStyles.sm, color = colors.fgMuted)
                            IconButton(onClick = { replyOpen = false }) {
                                LucideGlyph(Lucide.X, size = 16.dp, contentDescription = "Collapse reply")
                            }
                        }
                        TaskReplyBox(reply, sheet.onDismiss, 104.dp)
                    }
                }
            }
            LaunchedEffect(focusReply) {
                if (focusReply) { withFrameNanos { }; sheet.onFocusReply(); focusReply = false }
            }
        }
    }
}

@Composable
private fun RouteTopBar(sheet: TaskSheetState) {
    val colors = Jarvis.colors
    val projects by sheet.context.backend.projects.collectAsStateWithLifecycle()
    val project = projects.firstOrNull { it.id == sheet.context.route.projectId }?.name ?: "Tasks"
    val parentId = sheet.task.parent
    val parentTitle = sheet.tasks.firstOrNull { it.id == parentId }?.title ?: sheet.archivedLinks.firstOrNull { it.id == parentId }?.title
    BoxWithConstraints(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        val showParent = maxWidth >= 540.dp && parentId != null && sheet.previousTaskId == null
        Row(Modifier.widthIn(max = 1520.dp).fillMaxWidth().padding(start = 16.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                val previous = sheet.previousTaskId
                if (previous != null) TextButton(onClick = sheet.onDismiss, contentPadding = PaddingValues(0.dp), modifier = Modifier.weight(1f, fill = false)) {
                    Text("‹ ${sheet.previousTaskTitle ?: previous}", maxLines = 1, overflow = TextOverflow.Ellipsis)
                } else Text(project, Modifier.weight(if (showParent) .35f else 1f, fill = false), style = TextStyles.sm.copy(fontWeight = FontWeight.Bold),
                    color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (showParent) TextButton(onClick = { sheet.context.openTask(parentId) },
                    modifier = Modifier.weight(.65f, fill = false), contentPadding = PaddingValues(horizontal = 6.dp)) {
                    Text("/ ${parentTitle ?: parentId}", maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text(" /  ${sheet.task.id}", style = TaskType.xs, color = colors.fgMuted, maxLines = 1)
            }
            if (!sheet.editing) IconButton(onClick = { sheet.onEditChange(true) }) {
                LucideGlyph(TaskIcons.Pencil, size = 18.dp, contentDescription = "Edit ${sheet.task.id}")
            }
            TaskViewMenu(sheet.designId, sheet.onSelectDesign)
            IconButton(onClick = sheet.onDismiss) { LucideGlyph(Lucide.X, size = 18.dp, contentDescription = "Close the task") }
        }
    }
}

@Composable
private fun RouteHero(sheet: TaskSheetState, attention: RouteAttention, wide: Boolean, onAttention: () -> Unit, modifier: Modifier) {
    val task = sheet.task
    val status = sheet.status
    val colors = Jarvis.colors
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), itemVerticalAlignment = Alignment.CenterVertically) {
            TaskStatusMenu(task, taskStatusWords(task.status), status.waitingEnabled, !status.saving, status.onChoose)
            attention.label?.let { label ->
                Surface(onClick = onAttention, shape = RoundedCornerShape(50), color = colors.warning.copy(alpha = .10f)) {
                    Row(Modifier.heightIn(min = 48.dp).padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                        LucideGlyph(Lucide.CircleAlert, size = 14.dp, tint = colors.warning)
                        Text(label, style = TaskType.xsSemibold, color = colors.warning)
                    }
                }
            }
        }
        TaskDetailText(refLinkedText(task.title), Modifier.semantics { heading() }, color = colors.fg,
            style = TextStyles.lg.copy(fontSize = if (wide) 44.sp else 29.sp, lineHeight = if (wide) 49.sp else 33.sp,
                letterSpacing = (-.6).sp, fontWeight = FontWeight.Bold))
        sheet.fields.goal?.let { Text(it, style = TextStyles.base, color = colors.fgMuted) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            task.inProgressMinutes?.takeIf { it > 0 }?.let { RouteQuiet("In progress ${formatMinutes(it.toDouble())}") }
            sheet.record.delivery?.let { RouteQuiet(routeDeliveryLabel(it)) }
            if (task.archived) RouteQuiet("Archived")
            if (task.status == "waiting" && task.waiting != null) RouteQuiet(waitingSummary(task, sheet.now))
        }
        if (task.refs.isNotEmpty()) TaskRefs(task.refs, 180.dp)
        if (status.waitingForm) TaskWaitingForm(task.waiting, status.saving, status.workDayStart,
            { note, until -> status.onSet("waiting", note, until) }, status.onCancelWaiting)
        if (status.confirmDrop) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Drop ${task.id}? It will not be done.")
            Button(onClick = { status.onSet("dropped", null, null) }, enabled = !status.saving) { Text("Drop it") }
            TextButton(onClick = status.onCancelDrop) { Text("Keep") }
        }
        status.problem?.let { Text(it, color = colors.danger) }
    }
}
