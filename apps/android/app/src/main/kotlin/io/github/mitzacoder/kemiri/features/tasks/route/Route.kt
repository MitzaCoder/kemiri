package io.github.mitzacoder.kemiri.features.tasks.route

import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.protocol.BoardTaskActivity
import io.github.mitzacoder.kemiri.protocol.BoardTaskLive
import io.github.mitzacoder.kemiri.protocol.BoardTaskTimelineResponseDelivery

internal const val ROUTE_DOORS_MIN_WIDTH = 840

internal enum class RouteDoor(val label: String) { You("Your stop"), Got("Arrived"), Ahead("Ahead") }
internal enum class RouteStopState { Done, Now, Waits, Ahead }

internal data class RouteAttention(
    val questions: Int, val warnings: Int, val review: Boolean, val blocked: Boolean, val steps: Boolean,
) {
    val count = questions + warnings + listOf(review, blocked, steps).count { it }
    val label = when {
        questions > 0 -> if (questions == 1) "One answer needed" else "$questions answers needed"
        warnings > 0 -> if (warnings == 1) "One heads-up" else "$warnings heads-ups"
        blocked -> "Blocked"
        steps -> "Your steps to do"
        review -> "Ready for you to check"
        else -> null
    }
}

internal fun routeAttention(task: BoardTask, needsYou: TaskNeedsYou): RouteAttention {
    val warnings = needsYou.ownerQuestions.count(::isWarning)
    return RouteAttention(needsYou.ownerQuestions.size - warnings, warnings, task.status == "review",
        task.status == "blocked", needsYou.showSteps)
}

internal fun defaultRouteDoor(attentionCount: Int): RouteDoor = if (attentionCount > 0) RouteDoor.You else RouteDoor.Got

internal data class RouteStop(
    val id: String, val label: String, val detail: String, val state: RouteStopState,
    val at: String? = null, val taskId: String? = null,
)

internal fun routeParts(task: BoardTask, tasks: List<BoardTask>): List<BoardTask> =
    tasks.filter { it.parent == task.id }.sortedBy { it.order }

internal fun routeStops(task: BoardTask, parts: List<BoardTask>, attention: RouteAttention, liveSince: String? = null, now: Long): List<RouteStop> {
    val settled = isSettled(task.status)
    val waitsAtReview = attention.review && attention.count == 1
    val plan = task.live?.plan.orEmpty()
    val planNow = plan.indexOfFirst { it.status == "doing" }
    val partsNow = parts.firstOrNull { it.status == "in_progress" }?.id
    val stops = (if (plan.isNotEmpty()) plan.mapIndexed { index, step ->
        val current = !settled && index == planNow
        RouteStop("plan-$index", step.text, step.text, when {
            step.status == "done" -> RouteStopState.Done
            current -> RouteStopState.Now
            else -> RouteStopState.Ahead
        }, liveSince.takeIf { current })
    } else parts.map { part ->
        RouteStop("part-${part.id}", part.title, taskStatusWords(part.status), when {
            part.status == "done" -> RouteStopState.Done
            !settled && part.id == partsNow -> RouteStopState.Now
            else -> RouteStopState.Ahead
        }, part.settledAt ?: part.state?.since, part.id)
    }).toMutableList()
    if (stops.none { it.state == RouteStopState.Now } && !settled && !waitsAtReview) {
        val firstAhead = stops.indexOfFirst { it.state == RouteStopState.Ahead }
        val label = taskStatusWords(task.status)
        stops.add(firstAhead.takeIf { it >= 0 } ?: stops.size, RouteStop("current", label,
            if (task.status == "waiting" && task.waiting != null) waitingSummary(task, now) else label,
            RouteStopState.Now, liveSince ?: task.state?.since))
    }
    // A live plan step has no question ID. Keep the owner's interchange separate from the work.
    if (attention.count > (if (attention.review) 1 else 0)) {
        val current = stops.indexOfFirst { it.state == RouteStopState.Now }
        stops.add(if (current < 0) stops.size else current + 1, RouteStop("owner", "Your stop",
            attention.label ?: "Something needs your attention.", RouteStopState.Waits))
    }
    return buildList {
        add(RouteStop("asked", "Asked", "The task was opened.", RouteStopState.Done, task.createdAt))
        addAll(stops)
        add(RouteStop("review", "You check", "Check the work before closing the task.", when {
            waitsAtReview -> RouteStopState.Waits
            task.status == "done" -> RouteStopState.Done
            else -> RouteStopState.Ahead
        }))
        add(RouteStop("end", if (task.status == "dropped") "Dropped" else "Done",
            if (settled) "The task is closed." else "The task closes after the work is checked.",
            if (settled) RouteStopState.Done else RouteStopState.Ahead, task.settledAt))
    }
}

internal fun routeLiveNow(task: BoardTask, live: BoardTaskLive?, current: BoardTaskActivity?): BoardTaskActivity? {
    if (task.status != "in_progress" || live == null) return null
    val phase = if (taskUsesPartsSentence(task) || current?.kind == "question") {
        live.lines.lastOrNull { it.kind == "phase" && it.wrong == null }
    } else null
    return phase?.let { BoardTaskActivity(kind = "working", text = it.text, since = it.at, refs = emptyList()) } ?: current
}

internal fun routeDeliveryLabel(delivery: BoardTaskTimelineResponseDelivery): String = when (delivery.deployment) {
    "live" -> "Live"
    "failed" -> "Deploy failed"
    "pending" -> "Deploy pending"
    else -> if (delivery.integration?.landed == delivery.commits.size.toLong()) "Merged" else "Built, not confirmed merged"
}
