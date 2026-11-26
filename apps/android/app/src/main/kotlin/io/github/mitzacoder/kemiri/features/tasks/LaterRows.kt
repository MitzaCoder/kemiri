package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.BoardView
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

@Composable
internal fun LaterGroup(context: ProjectScreenContext, view: BoardView, tasks: List<BoardTask>, questions: List<BoardQuestion>) {
    var open by rememberSaveable { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        FoldHeading("Later", open, onToggle = { open = !open }, count = tasks.size + questions.size, chevronFirst = false, style = TaskType.sectionTitle)
        if (open) TaskGroup {
            tasks.forEachIndexed { index, task -> key(task.id) {
                if (index > 0) GroupHairline()
                LaterRequestRow(context, view, task)
            } }
            questions.forEachIndexed { index, question -> key(question.id) {
                if (index > 0 || tasks.isNotEmpty()) GroupHairline()
                QuestionCard(context, question, Modifier.padding(10.dp), compact = true, plain = true)
            } }
        }
    }
}

@Composable
private fun LaterRequestRow(context: ProjectScreenContext, view: BoardView, task: BoardTask) {
    val actions = LocalLaterActions.current ?: return
    val target = view.laterTarget(task) ?: return
    val record = target.record ?: return
    val questions = view.laterQuestions(task.id)
    val waiting = view.laterWaitingParts(task.id)
    var answering by rememberSaveable(task.id) { mutableStateOf(false) }
    val colors = Jarvis.colors
    Column(Modifier.padding(horizontal = 12.dp, vertical = 5.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).heightIn(min = 54.dp).clickable(role = Role.Button) { context.openTask(task.id) },
                horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
                LucideGlyph(Lucide.Clock, size = 17.dp, tint = colors.fgMuted)
                Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(task.title, style = TaskType.rowTitle, color = colors.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(listOfNotNull(laterNeedLabel(task, questions), laterReturnLabel(record),
                        if (waiting > 0) "$waiting ${if (waiting == 1) "part waits" else "parts wait"}" else null).joinToString(" · "),
                        style = TaskType.xs, color = colors.fgMuted)
                }
            }
            TextButton(enabled = !actions.busy, onClick = { actions.bringBack(target) }) { Text("Bring back", maxLines = 1) }
        }
        if (questions.isNotEmpty()) {
            TextButton(onClick = { answering = !answering }) { Text(if (answering) "Hide ${if (questions.size == 1) "question" else "questions"}" else "Answer") }
            if (answering) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                questions.forEach { question -> key(question.id) {
                    QuestionCard(context, question, compact = true, plain = true, showLaterControls = false)
                } }
            }
        }
    }
}

@Composable
internal fun TaskLaterPanel(context: ProjectScreenContext, task: BoardTask) {
    val actions = LocalLaterActions.current ?: return
    val subject by remember(context.board, task.id) { context.board.select { it.laterRequest(task.id)?.later } }
        .collectAsStateWithLifecycle(initialValue = null)
    val record = subject ?: return
    val visible by remember(context.board, task.id) { context.board.select { view ->
        if (task.parent == null) view.laterQuestions(task.id) else view.questions.filter { it.postponed == true && it.taskId == task.id && it.status == "open" }
    } }.collectAsStateWithLifecycle(emptyList())
    val colors = Jarvis.colors
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp), color = colors.surface,
        border = BorderStroke(1.dp, colors.border), contentColor = colors.fg) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                LucideGlyph(Lucide.Clock, size = 17.dp, tint = colors.fgMuted)
                Text(laterReturnLabel(record), Modifier.weight(1f), style = TaskType.rowTitle, color = colors.fgMuted)
                TextButton(enabled = !actions.busy, onClick = { context.board.view.value.laterTarget(task)?.let(actions::bringBack) }) { Text("Bring back") }
            }
            if (visible.isEmpty() && (task.state?.kind == "steps_needed" || !task.report.steps.isNullOrBlank())) {
                TaskHeading("Your steps")
                ReportSection(task, ReportSectionKind.Steps)
            }
            visible.forEach { question -> key(question.id) {
                QuestionCard(context, question, compact = true, plain = true, showLaterControls = false)
            } }
        }
    }
}
