package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

/** The same Task view picker can sit in any design's header. */
@Composable
internal fun TaskViewMenu(designId: String, onSelectDesign: (String) -> Unit) {
    if (TaskViewDesigns.entries.size <= 1) return

    var expanded by remember { mutableStateOf(false) }
    val colors = Jarvis.colors
    Box {
        IconButton(onClick = { expanded = true }) {
            LucideGlyph(Lucide.MoreHorizontal, modifier = Modifier.rotate(90f), size = 18.dp, contentDescription = "Task view")
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }, containerColor = colors.surface) {
            Text("Task view", Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() },
                style = MaterialTheme.typography.titleSmall, color = colors.fg)
            Column(Modifier.width(248.dp).selectableGroup()) {
                TaskViewDesigns.entries.forEach { design ->
                    val selected = design.id == designId
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp)
                            .selectable(selected, role = Role.RadioButton, onClick = {
                                expanded = false
                                onSelectDesign(design.id)
                            }).padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        RadioButton(selected = selected, onClick = null)
                        Column {
                            Text(design.label, style = MaterialTheme.typography.bodyMedium, color = colors.fg)
                            Text(design.description, style = MaterialTheme.typography.bodySmall, color = colors.fgMuted)
                        }
                    }
                }
            }
        }
    }
}
