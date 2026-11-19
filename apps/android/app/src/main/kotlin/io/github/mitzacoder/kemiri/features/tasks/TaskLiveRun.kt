package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.protocol.BoardTaskLiveCounters
import io.github.mitzacoder.kemiri.protocol.BoardTaskLivePulse
import java.time.Duration
import java.time.Instant
import java.time.format.DateTimeParseException

/** Match the web pulse: whole seconds until a minute, then whole minutes. */
internal fun pulseElapsed(since: String, now: Instant): String? {
    val started = try { Instant.parse(since) } catch (_: DateTimeParseException) { return null }
    val seconds = Duration.between(started, now).seconds.coerceAtLeast(0)
    return if (seconds < 60) "$seconds s" else "${seconds / 60} min"
}

internal fun livePulseDescription(pulse: BoardTaskLivePulse, elapsed: String?): String =
    "Run pulse: " + listOfNotNull(pulse.label, pulse.tool, elapsed).joinToString(", ")

/** Match protocol's liveCounterLabels, including order and omission of zero counts. */
internal fun liveCounterLabels(counters: BoardTaskLiveCounters?): List<String> = buildList {
    if (counters == null) return@buildList
    fun count(number: Long, noun: String, suffix: String = "") {
        if (number > 0) add("$number $noun${if (number == 1L) "" else "s"}$suffix")
    }
    count(counters.steps, "step")
    count(counters.filesChanged, "file", " changed")
    count(counters.filesSaved, "file", " saved")
    count(counters.commits, "commit")
    count(counters.checks, "check")
}
