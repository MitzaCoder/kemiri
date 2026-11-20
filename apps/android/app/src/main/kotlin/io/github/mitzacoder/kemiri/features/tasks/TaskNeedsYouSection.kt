package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.protocol.ThreadSummary
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.mix

@Composable
internal fun TaskNeedsYouSection(context: ProjectScreenContext, task: BoardTask, needsYou: TaskNeedsYou, nextPlacement: ReportNextPlacement?, blockers: List<Blocker>, threads: List<ThreadSummary>, closing: Boolean, onCloseTask: () -> Unit, onFocusReply: () -> Unit) {
    val colors = Jarvis.colors
    Surface(
        Modifier.fillMaxWidth(), shape = RoundedCornerShape(14.dp),
        color = colors.accent2.mix(colors.bg, 7f), contentColor = colors.fg,
        border = BorderStroke(1.dp, colors.accent2.mix(colors.border, 36f)),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            TaskHeading("Needs you")
            needsYou.ownerQuestions.forEachIndexed { index, question -> key(question.id) {
                if (index > 0) HorizontalDivider(color = colors.borderStrong)
                QuestionCard(context, question, askedBy = questionAskedBy(question, threads), compact = true, plain = true)
            } }
            if (needsYou.showSteps) {
                if (needsYou.ownerQuestions.isNotEmpty()) HorizontalDivider(color = colors.borderStrong)
                TaskReadingSection("Your steps") { ReportSection(task, ReportSectionKind.Steps) }
            }
            if (needsYou.review) {
                if (needsYou.ownerQuestions.isNotEmpty() || needsYou.showSteps) HorizontalDivider(color = colors.borderStrong)
                TaskHeading("Check the work")
                if (nextPlacement == ReportNextPlacement.Review) ReportSection(task, ReportSectionKind.Next)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Button(onClick = onCloseTask, enabled = !closing, modifier = Modifier.heightIn(min = 48.dp)) { Text("It works: close the task") }
                    OutlinedButton(onClick = onFocusReply, modifier = Modifier.heightIn(min = 48.dp)) { Text("Something is off…") }
                }
            }
            if (needsYou.blocked) {
                if (needsYou.ownerQuestions.isNotEmpty() || needsYou.showSteps) HorizontalDivider(color = colors.borderStrong)
                task.blockedReason?.takeIf { it.isNotBlank() }?.let { ReportMarkdown(it) }
                if (blockers.isNotEmpty()) Column {
                    TaskHeading("Blocked by")
                    blockers.forEach { TaskFactLink(it.id, it.title, context::openTask) }
                }
            }
        }
    }
}
