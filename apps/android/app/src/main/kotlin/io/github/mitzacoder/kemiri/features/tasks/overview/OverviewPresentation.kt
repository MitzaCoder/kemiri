package io.github.mitzacoder.kemiri.features.tasks.overview

import io.github.mitzacoder.kemiri.protocol.*
import java.time.Instant

internal fun overviewTime(at: String): Long? = runCatching { Instant.parse(at).toEpochMilli() }.getOrNull()
internal fun overviewCount(count: Long, unit: String, plural: String = "${unit}s") = "$count ${if (count == 1L) unit else plural}"
internal fun overviewDuration(ms: Double): String {
    val minutes = (ms / 60_000).toLong().coerceAtLeast(0)
    val hours = minutes / 60
    return when {
        minutes < 1 -> "less than a minute"
        hours >= 24 -> "${hours / 24} d" + if (hours % 24 == 0L) "" else " ${hours % 24} h"
        hours > 0 -> "$hours h" + if (minutes % 60 == 0L) "" else " ${minutes % 60} min"
        else -> "$minutes min"
    }
}
internal fun overviewAge(at: String, now: Long) = overviewTime(at)?.let { overviewDuration((now - it).toDouble()) }

internal fun overviewOpening(counts: OverviewGetResponseCounts, now: Long, coordinators: Int = 0): String {
    val scope = if (coordinators > 1) " across $coordinators coordinators" else ""
    val open = "${overviewCount(counts.open, "request")} ${if (counts.open == 1L) "is" else "are"} open$scope"
    if (counts.waitingOnOwner == 0L) return "$open, and nothing waits on you."
    val age = counts.oldestWaitSince?.let { overviewAge(it, now) }?.let { " for up to $it" }.orEmpty()
    return "$open, and ${overviewCount(counts.waitingOnOwner, "thing")} ${if (counts.waitingOnOwner == 1L) "waits" else "wait"} on you$age."
}

internal fun overviewRosterFacts(counts: OverviewGetResponseCounts): String =
    "${overviewCount(counts.open, "request")} open · ${counts.waitingOnOwner} ${if (counts.waitingOnOwner == 1L) "waits" else "wait"} on you"

internal fun overviewEstimateMinutes(value: Double): String {
    val minutes = value.toInt()
    if (minutes > 360) return "more than 6 h"
    if (minutes < 5) return "under 5 min"
    if (minutes < 60) return "$minutes min"
    val fraction = when (minutes % 60) { 15 -> "¼"; 30 -> "½"; 45 -> "¾"; else -> "" }
    return "${minutes / 60}$fraction h"
}

private fun overviewRange(low: Double, high: Double) = when {
    low > 360 -> "more than 6 h"
    low == high -> overviewEstimateMinutes(low)
    else -> "${overviewEstimateMinutes(low)} to ${overviewEstimateMinutes(high)}"
}

internal fun estimateOverrun(estimate: OverviewTimeLeft?, elapsedMs: Long): Boolean = when (estimate) {
    is OverviewTimeLeftRange -> estimate.overrun == true || estimate.overrunInMs?.let { elapsedMs >= it } == true
    is OverviewTimeLeftUsual -> estimate.longer || elapsedMs >= estimate.longerInMs
    else -> false
}

internal data class OverviewEstimateLine(val title: String, val detail: String, val stopped: Boolean = false)
internal fun overviewEstimateLine(estimate: OverviewTimeLeft?, elapsedMs: Long): OverviewEstimateLine? {
    val overrun = estimateOverrun(estimate, elapsedMs)
    fun basis(source: String) = if (source == "project") " · project history" else ""
    return when (estimate) {
        is OverviewTimeLeftRange -> if (overrun) OverviewEstimateLine("Running longer than estimated", "The first range has passed.") else
            OverviewEstimateLine("About ${overviewEstimateMinutes(estimate.minutes)}", "${overviewRange(estimate.low, estimate.high)} of agent work${basis(estimate.basis)}")
        is OverviewTimeLeftUsual -> if (overrun) OverviewEstimateLine("Longer than usual", "For a request without parts.") else
            OverviewEstimateLine("Usually ${overviewRange(estimate.low, estimate.high)}", "For a request without parts${basis(estimate.basis)}.")
        is OverviewTimeLeftStopped -> OverviewEstimateLine("Stopped", estimate.then?.let {
            "Then about ${overviewEstimateMinutes(it.minutes)} (${overviewRange(it.low, it.high)})${basis(it.basis)}."
        } ?: if (estimate.reason == "review") "Waiting for review." else "Waiting on you.", stopped = true)
        is OverviewTimeLeftNone -> OverviewEstimateLine("No estimate", when (estimate.reason) {
            "not_started" -> "Not started."
            "no_parts" -> "Not split into parts yet."
            "not_enough_history" -> "Not enough history yet."
            "outside_wait" -> "Waiting on something outside this request."
            "wide_range" -> "The range is too wide to be useful."
            "all_parts_done" -> "All parts are done."
            "already_reviewed" -> "Already reached its first review."
            else -> "No range is available."
        })
        else -> null
    }
}

internal fun overviewFlightOrder(rows: List<OverviewGetResponseInFlightItem>, tasks: Map<String, BoardTask>, elapsedMs: Long) =
    rows.sortedBy { row -> when (tasks[row.requestId]?.state?.kind) {
        "failed" -> 0
        "paused" -> 1
        else -> if (estimateOverrun(row.left, elapsedMs)) 2 else 3
    } }
