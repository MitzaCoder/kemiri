package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.protocol.BoardLivePlanStep
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

private const val PLAN_PHONE_WIDTH_DP = 480

/** Live folds a long plan on a phone; a finished Work row always opens to the full checklist. */
@Composable
internal fun TaskLivePlan(steps: List<BoardLivePlanStep>, foldOnPhone: Boolean = false) {
    val plan = remember(steps) { livePlan(steps) }
    if (plan.steps.isEmpty()) return
    val colors = Jarvis.colors
    val foldOnThisScreen = foldOnPhone && LocalConfiguration.current.screenWidthDp <= PLAN_PHONE_WIDTH_DP
    var expanded by rememberSaveable { mutableStateOf(false) }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        FlowRow(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            FlowRow(
                Modifier.clearAndSetSemantics { heading(); contentDescription = plan.description },
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Plan", style = TaskType.sectionTitle, color = colors.fg)
                Text(plan.progress, style = TaskType.xs, color = colors.fgMuted)
            }
            if (plan.canFold(foldOnThisScreen)) {
                Box(
                    Modifier.heightIn(min = 48.dp).clickable(role = Role.Button) { expanded = !expanded }
                        .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
                        .padding(horizontal = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(if (expanded) "Hide steps" else "Show steps", style = TaskType.xsSemibold, color = colors.fgMuted)
                }
            }
        }
        plan.visibleSteps(foldOnThisScreen, expanded).forEach { PlanStepRow(it) }
    }
}

@Composable
private fun PlanStepRow(step: LivePlanStep) {
    val colors = Jarvis.colors
    val textColor = when (step.status) {
        LivePlanStepStatus.Todo -> colors.fgSubtle
        LivePlanStepStatus.Doing -> colors.fg
        LivePlanStepStatus.Done -> colors.fgMuted
    }
    Row(
        Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = step.description },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.padding(top = 1.dp).size(16.dp), contentAlignment = Alignment.Center) {
            when (step.status) {
                LivePlanStepStatus.Todo -> LucideGlyph(TaskIcons.Circle, size = 14.dp, tint = textColor)
                LivePlanStepStatus.Doing -> Text("◐", style = TaskType.xsSemibold, color = textColor)
                LivePlanStepStatus.Done -> LucideGlyph(Lucide.Check, size = 16.dp, tint = colors.success)
            }
        }
        Text(step.text, Modifier.weight(1f), style = if (step.status == LivePlanStepStatus.Doing) TaskType.xsSemibold else TaskType.xs,
            color = textColor)
    }
}
