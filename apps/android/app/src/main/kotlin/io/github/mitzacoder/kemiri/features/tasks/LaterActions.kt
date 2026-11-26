package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.ClientException
import io.github.mitzacoder.kemiri.data.HarnessFeature
import io.github.mitzacoder.kemiri.data.boardConflict
import io.github.mitzacoder.kemiri.data.collectSettings
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.BoardLaterSetRequest
import io.github.mitzacoder.kemiri.protocol.BoardLaterSetResponse
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

internal val LocalLaterActions = staticCompositionLocalOf<LaterActions?> { null }

internal class LaterActions(
    private val projectId: String,
    private val scope: CoroutineScope,
    private val workDayStart: () -> String,
    private val write: suspend (BoardLaterSetRequest) -> BoardLaterSetResponse,
    private val refreshBoard: suspend () -> Unit,
    val snackbar: SnackbarHostState,
) {
    var target by mutableStateOf<LaterTarget?>(null)
        private set
    var busy by mutableStateOf(false)
        private set

    fun open(target: LaterTarget) {
        if (busy) return
        this.target = target
    }

    fun dismiss() {
        if (!busy) target = null
    }

    fun postpone(target: LaterTarget, choice: LaterChoice) = change(target, choice.until?.toString(), choice.whenLast)
    fun bringBack(target: LaterTarget) = change(target, null, false)

    private fun change(target: LaterTarget, until: String?, whenLast: Boolean) {
        if (busy) return
        busy = true
        scope.launch {
            val response = try {
                write(target.request(projectId, until, whenLast, workDayStart(), ZoneId.systemDefault()))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                val message = if (boardConflict(error)) {
                    refreshBoard()
                    "This item changed. Open Later again and check the new version."
                } else (error as? ClientException)?.message ?: "Could not change Later. Try again."
                busy = false
                this@LaterActions.target = null
                snackbar.currentSnackbarData?.dismiss()
                snackbar.showSnackbar(message)
                return@launch
            }
            busy = false
            this@LaterActions.target = null
            snackbar.currentSnackbarData?.dismiss()
            val record = response.later ?: return@launch
            if (snackbar.showSnackbar(laterPutAsideLabel(record), actionLabel = "Undo", duration = SnackbarDuration.Short) == SnackbarResult.ActionPerformed) {
                val previous = target.record?.takeIf { isoMillis(it.until) > System.currentTimeMillis() }
                try {
                    write(target.request(projectId, previous?.until, previous?.whenLast == true, workDayStart(), ZoneId.systemDefault(), response.revision))
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    refreshBoard()
                    snackbar.showSnackbar("Could not undo. Check the item’s current Later setting.")
                }
            }
        }
    }
}

/** One picker and Undo surface per screen; individual rows do not keep dialog state after leaving a list. */
@Composable
internal fun LaterActionHost(context: ProjectScreenContext, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    if (!connection.supports(HarnessFeature.ATTENTION_LATER)) {
        Box(modifier) { content() }
        return
    }
    val start by context.repository.collectSettings { it.workDayStart }
    val latestStart = rememberUpdatedState(start)
    val scope = rememberCoroutineScope()
    val board = context.board
    val client = context.backend.client
    val actions = remember(board, client) {
        LaterActions(context.route.projectId, scope, { latestStart.value }, { request ->
            client.request(request, explicitNulls = if (request.until == null) setOf("until") else emptySet())
        }, board::load, SnackbarHostState())
    }
    Box(modifier) {
        CompositionLocalProvider(LocalLaterActions provides actions) { content() }
        SnackbarHost(actions.snackbar, Modifier.align(Alignment.BottomCenter).padding(horizontal = 12.dp))
    }
    actions.target?.let { target ->
        key(target.id, target.revision) { LaterSheet(target, start, actions) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LaterSheet(target: LaterTarget, start: String, actions: LaterActions) {
    val colors = Jarvis.colors
    val zone = ZoneId.systemDefault()
    val now = Instant.ofEpochMilli(rememberTaskMinuteNow())
    val choices = laterChoices(now, zone, start, target.urgent, target.question)
    var datePickerOpen by remember { mutableStateOf(false) }
    ModalBottomSheet(
        onDismissRequest = actions::dismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = colors.surface, contentColor = colors.fg,
    ) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                LucideGlyph(Lucide.Clock, size = 20.dp, tint = colors.fgMuted)
                Text("Later", Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge)
            }
            Text(target.title, Modifier.padding(top = 3.dp, bottom = 12.dp), style = MaterialTheme.typography.bodyMedium,
                color = colors.fgMuted, maxLines = 3, overflow = TextOverflow.Ellipsis)
            for (choice in choices) {
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(enabled = !actions.busy, role = Role.Button) {
                    if (choice.pickDate) datePickerOpen = true else actions.postpone(target, choice)
                }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(choice.label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    choice.until?.let { Text(formatWaitingTime(it.toString(), zone), style = TaskType.xs, color = colors.fgMuted) }
                    if (choice.pickDate) LucideGlyph(Lucide.ChevronRight, size = 16.dp, tint = colors.fgMuted)
                }
            }
            target.record?.let { TextButton(onClick = { actions.bringBack(target) }, enabled = !actions.busy) { Text("Bring back now") } }
            Text(if (target.urgent) "Warnings and failures come back by the next work-day start."
                else "Agents will not ask again until then.", Modifier.padding(top = 8.dp), style = TaskType.xs, color = colors.fgMuted)
        }
    }
    if (datePickerOpen) LaterDatePicker(now, zone, start, onDismiss = { datePickerOpen = false }) { until ->
        datePickerOpen = false
        actions.postpone(target, LaterChoice("Pick a date", until))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LaterDatePicker(now: Instant, zone: ZoneId, start: String, onDismiss: () -> Unit, onPick: (Instant) -> Unit) {
    fun localDate(utc: Long): LocalDate = Instant.ofEpochMilli(utc).atOffset(ZoneOffset.UTC).toLocalDate()
    val today = now.atZone(zone).toLocalDate()
    val selectable = remember(now, zone, start) {
        object : SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long) = laterDateDeadline(localDate(utcTimeMillis), now, zone, start) != null
            override fun isSelectableYear(year: Int) = year in today.year..today.plusDays(30).year
        }
    }
    val date = rememberDatePickerState(initialSelectedDateMillis = today.plusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC).toEpochMilli(),
        yearRange = today.year..today.plusDays(30).year, selectableDates = selectable)
    val selected = date.selectedDateMillis?.let { laterDateDeadline(localDate(it), now, zone, start) }
    DatePickerDialog(onDismissRequest = onDismiss,
        confirmButton = { TextButton(enabled = selected != null, onClick = { selected?.let(onPick) }) { Text("Put aside") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }) { DatePicker(date, showModeToggle = false) }
}

/** Swiping reveals Later without treating the row as a deletion or changing its status. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun LaterSwipe(onLater: (() -> Unit)?, content: @Composable () -> Unit) {
    if (onLater == null) { content(); return }
    val latest = rememberUpdatedState(onLater)
    val state = rememberSwipeToDismissBoxState(confirmValueChange = {
        if (it == SwipeToDismissBoxValue.EndToStart) latest.value()
        false
    })
    SwipeToDismissBox(state = state, enableDismissFromStartToEnd = false,
        backgroundContent = {
            if (state.dismissDirection == SwipeToDismissBoxValue.EndToStart) {
                Box(Modifier.fillMaxSize().background(Jarvis.colors.surface2).padding(end = 14.dp), contentAlignment = Alignment.CenterEnd) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        LucideGlyph(Lucide.Clock, size = 18.dp, tint = Jarvis.colors.fgMuted)
                        Text("Later", style = TaskType.xs, color = Jarvis.colors.fgMuted)
                    }
                }
            }
        }) { content() }
}
