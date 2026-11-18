package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.protocol.BoardTaskTimelineResponseDelivery
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

internal data class DeliveryStep(val title: String, val detail: String, val complete: Boolean)

/** Only attributed commits create Delivery. Missing evidence never looks like success. */
internal fun deliverySteps(delivery: BoardTaskTimelineResponseDelivery?): List<DeliveryStep> {
    val count = delivery?.commits?.size?.takeIf { it > 0 } ?: return emptyList()
    val integration = delivery.integration
    val landed = integration?.landed
    val merged = landed == count.toLong()
    return listOf(
        DeliveryStep("Built", "$count ${if (count == 1) "commit" else "commits"}", true),
        DeliveryStep("Merged", when {
            integration == null -> "Not observed"
            merged -> "On ${integration.ref.removePrefix("refs/heads/")}"
            landed != null && landed > 0 -> "$landed of $count on the integration ref"
            else -> "Not landed"
        }, merged),
        DeliveryStep("Live", when (delivery.deployment) {
            "live" -> "Deploy succeeded"
            "pending" -> "Not fully live"
            "failed" -> "Deploy failed"
            "unknown" -> "Status unknown"
            else -> "Not observed"
        }, delivery.deployment == "live"),
    )
}

@Composable
internal fun TaskDelivery(delivery: BoardTaskTimelineResponseDelivery) {
    val colors = Jarvis.colors
    val steps = deliverySteps(delivery)
    if (steps.isEmpty()) return
    TaskReadingSection("Delivery") {
        steps.forEach { step ->
            Row(Modifier.semantics(mergeDescendants = true) { stateDescription = if (step.complete) "Complete" else "Not complete" },
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                LucideGlyph(if (step.complete) Lucide.Check else TaskIcons.Circle, Modifier.padding(top = 2.dp), size = 16.dp,
                    tint = if (step.complete) colors.success else colors.fgMuted)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(step.title, style = TaskType.sectionTitle, color = colors.fg)
                    Text(step.detail, style = TaskType.xs, color = colors.fgMuted)
                }
            }
        }
        var changesOpen by rememberSaveable { mutableStateOf(false) }
        TaskFold("Changes", changesOpen, { changesOpen = !changesOpen }) {
            delivery.commits.forEach { Text(it.take(12), Modifier.padding(start = 24.dp), style = TaskType.metaMono, color = colors.fgMuted) }
        }
    }
}
