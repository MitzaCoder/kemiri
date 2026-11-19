package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.features.usage.usageMoney
import io.github.mitzacoder.kemiri.protocol.TaskSubscriptionUsage
import io.github.mitzacoder.kemiri.protocol.TaskUsagePart
import io.github.mitzacoder.kemiri.protocol.UsageTaskResponse
import java.util.Locale
import kotlin.math.roundToInt

internal fun bindingShareText(subscription: TaskSubscriptionUsage): String? {
    val window = subscription.bindingWindow ?: return null
    val percent = if (window.share > 0 && window.share < .01) "<1%" else "${(window.share * 100).roundToInt()}%"
    val unit = when (window.windowMinutes) {
        10_080.0 -> "week"
        1440.0 -> "day"
        300.0 -> "5-hour window"
        else -> null
    }
    val label = subscription.label
    val article = if (label.firstOrNull()?.lowercaseChar() in "aeiou".toList()) "an" else "a"
    val denominator = if (unit == null) "the $label ${window.label.lowercase(Locale.ROOT)}" else "$article $label $unit"
    return "≈ $percent of $denominator"
}

internal data class TaskUsagePartRow(val part: TaskUsagePart, val depth: Int)
internal data class TaskUsagePresentation(val headline: String, val parts: List<TaskUsagePartRow>, val notes: List<String>)

private fun countLabel(count: Long, singular: String) = "$count $singular${if (count == 1L) "" else "s"}"

internal fun taskUsagePresentation(usage: UsageTaskResponse?, taskId: String): TaskUsagePresentation? {
    if (usage == null || usage.total.requests == 0L) return null
    val binding = usage.subscriptions.filter { it.bindingWindow != null }.maxByOrNull { it.apiValue }
    val workers = usage.conversations.filter { it.kind == "worker" }.map { it.threadId to it.workerId }.distinct().size
    val threads = usage.conversations.filter { it.kind == "thread" }.map { it.threadId }.distinct().size
    val counts = listOf(workers to "worker", threads to "thread", usage.parts.size to "subtask")
        .filter { (count, _) -> count > 0 }.joinToString(", ") { (count, noun) -> countLabel(count.toLong(), noun) }
    val depthByTask = mutableMapOf(taskId to -1)
    val parts = usage.parts.map { part ->
        val depth = (depthByTask[part.parentTaskId] ?: -1) + 1
        depthByTask[part.taskId] = depth
        TaskUsagePartRow(part, depth)
    }
    return TaskUsagePresentation(
        listOfNotNull("${usageMoney(usage.total.apiValue)} at API prices", binding?.let(::bindingShareText), counts.takeIf { it.isNotEmpty() }).joinToString(" · "),
        parts,
        buildList {
            if (usage.notes.unpricedRequests > 0) add("${countLabel(usage.notes.unpricedRequests, "unpriced request")} not included in dollar amounts.")
            if (usage.notes.missingLimitShare.isNotEmpty()) add("Limit share unavailable for some or all requests on ${usage.notes.missingLimitShare.joinToString()}.")
            if (usage.subscriptions.any { it.assumed } || usage.payAsYouGo.any { it.assumed }) add("Some older requests use assumed billing.")
        },
    )
}
