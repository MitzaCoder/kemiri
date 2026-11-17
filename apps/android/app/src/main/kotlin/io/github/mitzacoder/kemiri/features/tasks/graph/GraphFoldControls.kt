package io.github.mitzacoder.kemiri.features.tasks.graph

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

/** A fixed toolbar row in both native views and both modes; chips never consume graph layout slots. */
@Composable
internal fun GraphFoldControls(mode: GraphMode, onMode: (GraphMode) -> Unit, folds: List<GraphFold>, expanded: Set<GraphFoldKind>, onFold: (GraphFoldKind) -> Unit) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        SingleChoiceSegmentedButtonRow {
            GraphMode.entries.forEachIndexed { index, choice ->
                SegmentedButton(selected = mode == choice, onClick = { onMode(choice) }, shape = SegmentedButtonDefaults.itemShape(index, GraphMode.entries.size),
                    modifier = Modifier.heightIn(min = 48.dp).semantics {
                        contentDescription = if (choice == GraphMode.Live) "Live graph. Fold quiet standalone tasks" else "All graph. Show every task"
                    }) { Text(choice.label) }
            }
        }
        folds.forEach { fold ->
            val open = fold.kind in expanded
            FilterChip(selected = open, enabled = mode == GraphMode.Live, onClick = { onFold(fold.kind) },
                label = { Text("${fold.kind.label} · ${fold.taskIds.size} ${if (open) "▾" else "▸"}") },
                modifier = Modifier.heightIn(min = 48.dp).semantics {
                    contentDescription = "${fold.kind.label}, ${fold.taskIds.size} tasks. ${if (open) "Close" else "Open"} group"
                    stateDescription = if (mode == GraphMode.All) "Shown in All" else if (open) "Expanded" else "Collapsed"
                })
        }
    }
}
