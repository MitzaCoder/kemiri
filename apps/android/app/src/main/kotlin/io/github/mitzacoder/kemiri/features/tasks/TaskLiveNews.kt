package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.status.BannerTone
import io.github.mitzacoder.kemiri.features.status.ToneBanner
import io.github.mitzacoder.kemiri.protocol.BoardLiveLine
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

internal class LiveNewsActions(
    val openWorkLog: (BoardLiveLine, String) -> (() -> Unit)?,
    val markWrong: suspend (String) -> Unit,
)

@Composable
internal fun LiveAutoLine(
    line: BoardLiveLine, auto: AutoLinePresentation, description: String, news: LiveNewsActions,
    summary: @Composable (expanded: Boolean) -> Unit,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    var marking by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Column(
        Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClickLabel = if (expanded) "Hide recorded steps" else "Show recorded steps") { expanded = !expanded }
            .clearAndSetSemantics {
                contentDescription = description
                stateDescription = listOfNotNull(if (expanded) "Expanded" else "Collapsed", auto.wrongLabel).joinToString(", ")
            },
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) { summary(expanded) }
    if (expanded) Column(
        Modifier.fillMaxWidth().padding(top = 4.dp).background(Jarvis.colors.surface2, RoundedCornerShape(6.dp)).padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text("Recorded steps", Modifier.semantics { heading() }, style = TaskType.xsSemibold, color = Jarvis.colors.fg)
        val steps = auto.evidence.map { it to news.openWorkLog(line, it.entryId) }
        for ((step, open) in steps) {
            Text(step.label, style = TaskType.xs, color = Jarvis.colors.fg)
            if (open != null) TextButton(onClick = open, modifier = Modifier.heightIn(min = 48.dp).semantics {
                contentDescription = "Open the work log here: ${step.label}"
            }) { Text("Open the work log here", style = TaskType.xsSemibold, color = Jarvis.colors.fg) }
        }
        if (steps.none { it.second != null }) Text("The work log is not available for this run.", style = TaskType.xs, color = Jarvis.colors.fgMuted)
        if (auto.canMarkWrong) TextButton(
            enabled = !marking,
            onClick = {
                marking = true
                error = null
                scope.launch {
                    try { news.markWrong(line.id) }
                    catch (cause: CancellationException) { throw cause }
                    catch (cause: Exception) { error = cause.message ?: "Could not mark this line wrong. Try again." }
                    finally { marking = false }
                }
            },
        ) { Text("This is wrong", style = TaskType.xsSemibold) }
        if (auto.canMarkWrong) error?.let { message ->
            ToneBanner(BannerTone.Error, Modifier.semantics { liveRegion = LiveRegionMode.Polite }) {
                Text(message, style = TaskType.xs)
            }
        }
    }
}
