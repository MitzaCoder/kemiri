package io.github.mitzacoder.kemiri.features.tasks.graph

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.GraphCounts
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

@Composable
internal fun BubbleToolbar(viewSwitch: @Composable () -> Unit, counts: GraphCounts, mode: GraphMode, onMode: (GraphMode) -> Unit,
    viewOpen: Boolean, onView: (Boolean) -> Unit, closed: Boolean, onClosed: () -> Unit, resting: Boolean, onResting: () -> Unit,
    allLinks: Boolean, onAllLinks: () -> Unit, legend: Boolean, onLegend: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp)) {
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically) {
            viewSwitch()
            val modeShape = RoundedCornerShape(50)
            Row(Modifier.clip(modeShape).background(Jarvis.colors.surface).border(1.dp, Jarvis.colors.border, modeShape)
                .padding(2.dp).semantics { contentDescription = "Task visibility" }) {
                GraphMode.entries.forEach { option ->
                    TextButton(onClick = { onMode(option) }, modifier = Modifier.heightIn(min = 48.dp).widthIn(min = 48.dp)
                        .semantics { selected = mode == option }, shape = modeShape,
                        colors = ButtonDefaults.textButtonColors(contentColor = Jarvis.colors.fg,
                            containerColor = if (mode == option) Jarvis.colors.surface2 else androidx.compose.ui.graphics.Color.Transparent)) { Text(option.label, fontSize = 12.sp) }
                }
            }
            Box {
                TextButton(onClick = { onView(!viewOpen) }, modifier = Modifier.heightIn(min = 48.dp).semantics { stateDescription = if (viewOpen) "Expanded" else "Collapsed" }) { Text("View ▾", fontSize = 12.sp) }
                DropdownMenu(expanded = viewOpen, onDismissRequest = { onView(false) }) {
                    listOf(Triple("Closed tasks", closed, onClosed), Triple("Resting workers on the graph", resting, onResting),
                        Triple("All links", allLinks, onAllLinks), Triple("Legend", legend, onLegend)).forEach { (label, checked, toggle) ->
                        DropdownMenuItem(text = { Text(label) }, onClick = toggle,
                            leadingIcon = { Checkbox(checked, null) }, modifier = Modifier.heightIn(min = 48.dp).semantics { stateDescription = if (checked) "On" else "Off" })
                    }
                }
            }
        }
        Text("${counts.open} open · ${counts.working} working · ${counts.attention} need attention", color = Jarvis.colors.fgMuted,
            fontSize = 11.sp, modifier = Modifier.padding(vertical = 6.dp))
    }
    HorizontalDivider(color = Jarvis.colors.border)
}
