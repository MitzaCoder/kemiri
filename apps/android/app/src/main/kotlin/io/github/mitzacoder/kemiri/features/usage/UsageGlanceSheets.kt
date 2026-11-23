package io.github.mitzacoder.kemiri.features.usage

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.protocol.*
import java.text.NumberFormat
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope

@Composable
internal fun SpendGlanceSheet(row: SpendRow, range: UsageRange, totalCost: Double, backends: List<BackendSession>,
    openTask: (BackendConfig, String, String) -> Unit, openBreakdown: (SpendRow) -> Unit) {
    val reads by produceState<List<Pair<BackendConfig, UsageRead<RecordedUsage>>>?>(null, row, range, backends) {
        value = coroutineScope {
            row.portions.map { portion -> async {
                val backend = backends.firstOrNull { it.config.key == portion.computer.key }
                val connection = backend?.client?.state?.value
                val selection = portion.selection
                portion.computer to when {
                    backend == null || connection?.status != ConnectionStatus.Ready -> UsageRead(error = "Not connected.")
                    selection == null || !connection.supports(HarnessFeature.RECORDED_USAGE) -> UsageRead(error = "This breakdown is not available.")
                    else -> readUsage { backend.client.request(range.detail(selection)).usage }
                }
            } }.awaitAll()
        }
    }
    val first = row.portions.first()
    val reports = reads.orEmpty().mapNotNull { (computer, result) -> result.report?.let { computer to it } }
    GlanceHeading(row.label)
    ValueNote(listOfNotNull(range.month ?: range.period.label, computerNames(row.computers)).joinToString(" · "))
    Text(usageMoney(row.cost), style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
    ValueNote("of work at API prices" + if (totalCost > 0) " · ${usagePercent(row.cost / totalCost)} of everything recorded" else "")
    if (row.computers.size > 1) row.portions.groupBy { it.computer }.forEach { (computer, portions) ->
        UsageAmountRow(computer.name, portions.sumOf { it.group.cost })
    }
    (first.selection as? UsageSelectionTask)?.let { task ->
        OutlinedButton(onClick = { openTask(first.computer, task.projectId, task.taskId) }) { Text("Open the task") }
    }
    if (reads == null) LinearProgressIndicator(Modifier.fillMaxWidth())
    reads.orEmpty().forEach { (computer, result) -> result.error?.let { ValueNote("${computer.name}: $it") } }
    SpendDimension.entries.filter { it.kind != first.selection?.kind }.forEach { dimension ->
        val rows = spendRows(reports, dimension, includeTaskless = true)
        if (rows.isNotEmpty()) {
            Text(dimension.label, style = MaterialTheme.typography.titleMedium)
            OutlinedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                    rows.forEachIndexed { index, breakdown ->
                        if (index > 0) HorizontalDivider()
                        UsageAmountRow(breakdown.label, breakdown.cost, note = computerNames(breakdown.computers),
                            onClick = if (dimension == SpendDimension.Tasks && breakdown.portions.any { it.selection != null }) {
                                { openBreakdown(breakdown) }
                            } else null)
                    }
                }
            }
        }
    }
    Text("Tokens", style = MaterialTheme.typography.titleMedium)
    val groups = row.portions.map { it.group }
    val format = NumberFormat.getIntegerInstance()
    listOf("Input" to groups.sumOf { it.inputTokens }, "Cache read" to groups.sumOf { it.cacheReadTokens },
        "Cache write" to groups.sumOf { it.cacheWriteTokens }, "Output" to groups.sumOf { it.outputTokens }).forEach { (label, tokens) ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            Text(format.format(tokens), style = MaterialTheme.typography.labelLarge)
        }
    }
    val unpriced = groups.sumOf { it.unpricedRequests }
    if (unpriced > 0) ValueNote("$unpriced requests had no catalog price.")
}

@Composable
internal fun SubscriptionGlanceSheet(subscription: GlanceSubscription, month: SubscriptionMonth?, limits: List<GlanceLimit>,
    computers: List<GlanceComputer>, now: Double, refreshLimits: (BackendSession) -> Unit, openTask: (BackendConfig, String, String) -> Unit) {
    val latest = subscription.latest.reading
    var expanded by remember { mutableStateOf<String?>(null) }
    GlanceHeading(listOfNotNull(latest.label, latest.plan).joinToString(" · "))
    ValueNote(listOfNotNull(latest.account, computerNames(subscription.computers)).joinToString(" · "))
    parseTime(latest.updatedAt)?.let { ValueNote("Updated ${clockTime(it)}") }
    latest.error?.let { ValueNote("The last provider read failed: $it") }
    Text("Live limits", style = MaterialTheme.typography.titleMedium)
    if (limits.isEmpty()) ValueNote("No windows reported.")
    limits.forEach { limit -> key(limit.key) {
        GlanceLimitCard(limit, now, expanded == limit.window.id, false, { expanded = limit.window.id.takeUnless { expanded == it } },
            pauseBackends = computers.map { it.backend })
    } }
    // Send an explicit free-reset confirmation to the backend that supplied the displayed credit.
    val resetSource = subscription.members.firstOrNull { it.reading.manualResets != null } ?: subscription.latest
    computers.firstOrNull { it.backend.config.key == resetSource.computer.key }?.backend?.let { backend ->
        SubscriptionResets(resetSource.reading, backend) { refreshLimits(backend) }
    }
    HorizontalDivider()
    Text("This month", style = MaterialTheme.typography.titleLarge)
    if (computers.any { it.monthly.loading }) LinearProgressIndicator(Modifier.fillMaxWidth())
    computers.forEach { read -> read.monthly.error?.let { ValueNote("${read.backend.config.name}: monthly value could not be read. $it") } }
    if (month == null && computers.none { it.monthly.loading }) ValueNote("No recorded subscription work available this month.")
    if (month != null) {
        UsageAmountRow("Work at API prices", month.cost)
        val price = month.price?.monthlyPrice
        if (price == null) ValueNote("Monthly price not recorded. Set it in AI accounts.")
        else {
            UsageAmountRow("Monthly plan price", price, note = if (month.price?.kind == "owner") "Owner price" else "Default price")
            if (price > 0) ValueNote("${formatUsageRatio(month.cost / price)}× the monthly price")
        }
        if (month.priceConflict) ValueNote("Shared prices differ. The highest owner price, or highest default, is used.")
        if (computers.any { it.monthly.report == null || it.monthly.error != null }) ValueNote("Monthly work may be incomplete.")
        val models = month.portions.flatMap { it.second.models }.groupBy { it.model }.mapValues { (_, models) -> models.sumOf { it.apiValue } }
        if (models.isNotEmpty()) Text("Models", style = MaterialTheme.typography.titleMedium)
        models.entries.sortedByDescending { it.value }.forEach { UsageAmountRow(it.key, it.value) }
        month.portions.forEach { (computer, value) -> key(computer.key, value.billing) {
            val backend = computers.firstOrNull { it.backend.config.key == computer.key }?.backend
            val projects = backend?.projects?.collectAsStateWithLifecycle()?.value.orEmpty()
            if (value.topTasks.isNotEmpty() || value.coordinatorProjects.orEmpty().isNotEmpty()) {
                Text("Where it went · ${computer.name}", style = MaterialTheme.typography.titleMedium)
                value.topTasks.forEach { task ->
                    UsageAmountRow("${task.taskId} · ${task.title}", task.apiValue, onClick = { openTask(computer, task.projectId, task.taskId) })
                }
                value.coordinatorProjects.orEmpty().forEach { project ->
                    val name = projects.firstOrNull { it.id == project.projectId }?.name ?: project.projectId
                    UsageAmountRow("Coordinator · $name", project.apiValue)
                }
            }
        } }
    }
}
