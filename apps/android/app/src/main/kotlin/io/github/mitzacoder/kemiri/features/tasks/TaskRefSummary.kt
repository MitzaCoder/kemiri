package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.features.refs.refStatusWords

internal data class TaskRefSummary(val counts: String, val failingChecks: Boolean)

internal fun taskRefSummary(statuses: List<RefStatus?>): TaskRefSummary {
    fun count(noun: String, plural: String, count: Int) =
        if (count == 0) null else "$count ${if (count == 1) noun else plural}"

    val tickets = statuses.count { it is RefStatusJira }
    val pulls = statuses.count { it is RefStatusPull }
    val issues = statuses.count { it is RefStatusIssue }
    val links = statuses.size - tickets - pulls - issues
    val counts = listOfNotNull(count("ticket", "tickets", tickets), count("PR", "PRs", pulls),
        count("issue", "issues", issues), count("link", "links", links)).joinToString(" · ")
    return TaskRefSummary(counts, statuses.any(::taskRefHasFailingChecks))
}

internal fun taskRefStateLabel(status: RefStatus?): String = when (status) {
    is RefStatusJira, is RefStatusPull, is RefStatusIssue -> refStatusWords(status)
    else -> "Link"
}

/** Closed or merged checks are historical, not a warning. */
internal fun taskRefHasFailingChecks(status: RefStatus?) =
    status is RefStatusPull && status.state in setOf("open", "draft") && status.checks == "failing"
