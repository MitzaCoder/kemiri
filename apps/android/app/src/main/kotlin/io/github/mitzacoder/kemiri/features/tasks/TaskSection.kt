package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

@Composable
internal fun TaskHeading(title: String, modifier: Modifier = Modifier) {
    Text(title, modifier.semantics { heading() }, style = TaskType.sectionTitle.copy(fontWeight = FontWeight.SemiBold), color = Jarvis.colors.fgMuted)
}

@Composable
internal fun TaskReadingSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        TaskHeading(title)
        content()
    }
}

/** Keep a folded timeline's filters without composing the hidden content. */
@Composable
internal fun TaskFold(
    expanded: Boolean,
    onToggle: () -> Unit,
    heading: @Composable RowScope.() -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val saveableState = rememberSaveableStateHolder()
    HorizontalDivider(color = Jarvis.colors.border)
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onToggle)
            .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
            .heightIn(min = 48.dp).padding(vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        LucideGlyph(Lucide.ChevronRight, Modifier.rotate(if (expanded) 90f else 0f), size = 16.dp, tint = Jarvis.colors.fgMuted)
        heading()
    }
    if (expanded) saveableState.SaveableStateProvider("fold-content") {
        Column(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
    }
}

@Composable
internal fun TaskFold(title: String, expanded: Boolean, onToggle: () -> Unit, content: @Composable ColumnScope.() -> Unit) =
    TaskFold(expanded, onToggle, heading = { TaskHeading(title) }, content = content)
