package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.protocol.ArtifactsListResponsePartProofItem
import io.github.mitzacoder.kemiri.protocol.PartsDigest
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

@Composable
internal fun PartsChecklist(digest: PartsDigest, proof: List<ArtifactsListResponsePartProofItem>, onOpen: (String) -> Unit) {
    val colors = Jarvis.colors
    val rows = remember(digest, proof) { partsChecklist(digest, proof) }
    var expanded by rememberSaveable { mutableStateOf(false) }
    val hidden = rows.size - PARTS_CHECKLIST_PREVIEW
    TaskReadingSection("Parts · ${digest.done} of ${digest.total} done") {
        TaskGroup {
            rows.take(if (expanded) rows.size else PARTS_CHECKLIST_PREVIEW).forEachIndexed { index, row ->
                if (index > 0) GroupHairline()
                Row(
                    Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = "Open part") { onOpen(row.part.id) }
                        .heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top,
                ) {
                    val tone = taskKindTone(row.part.state)
                    LucideGlyph(taskStateGlyph(row.part.state), Modifier.padding(top = 3.dp), size = 16.dp,
                        tint = colors.taskStatus(tone), contentDescription = partStateLabel(row.part.state))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(row.part.title, style = TaskType.rowTitle, color = colors.fg)
                        if (row.summary.isNotBlank()) Text(row.summary, style = TaskType.xs, color = colors.fgMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(row.counts, style = TaskType.meta, color = if (row.part.checks.failed > 0) colors.danger else colors.fgSubtle)
                    }
                    LucideGlyph(Lucide.ChevronRight, Modifier.align(Alignment.CenterVertically), size = 14.dp, tint = colors.fgSubtle)
                }
            }
            if (hidden > 0) {
                GroupHairline()
                TextButton(onClick = { expanded = !expanded }, modifier = Modifier.heightIn(min = 48.dp).padding(start = 12.dp)) {
                    Text(if (expanded) "Show fewer parts" else "…$hidden more parts")
                }
            }
        }
    }
}

@Composable
internal fun ReopenPartDialog(saving: Boolean, problem: String?, onDismiss: () -> Unit, onReopen: (String) -> Unit) {
    var note by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = { if (!saving) onDismiss() }, title = { Text("Reopen with a note") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(note, { note = it.take(2000) }, label = { Text("What needs more work?") },
                    modifier = Modifier.fillMaxWidth(), enabled = !saving, minLines = 2)
                problem?.let { Text(it, color = Jarvis.colors.danger) }
            }
        },
        confirmButton = { TextButton(onClick = { onReopen(note.trim()) }, enabled = !saving && note.isNotBlank()) { Text("Reopen part") } },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !saving) { Text("Cancel") } },
    )
}
