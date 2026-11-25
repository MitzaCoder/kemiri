package io.github.mitzacoder.kemiri.features.usage

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.BackendConfig
import io.github.mitzacoder.kemiri.data.BackendSession
import io.github.mitzacoder.kemiri.protocol.CacheStats
import io.github.mitzacoder.kemiri.protocol.RecordedUsage
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import java.util.Locale
import kotlin.math.roundToInt

@Composable
internal fun GlanceHeading(label: String) {
    Text(label, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
}

internal fun resetCountdown(limit: GlanceLimit, now: Double): String? = limit.pace.resetsAt?.takeIf { it > now }?.let { formatDuration(it - now) }

@Composable
internal fun AttentionSummary(limits: List<GlanceLimit>, loading: Boolean) {
    val attention = limits.filter { it.status == LimitStatus.Near || it.status == LimitStatus.Hot }.take(2)
    val summary = when {
        attention.isNotEmpty() -> attention.joinToString("; ") { limit ->
            val name = limit.subscription.latest.reading.label
            val time = resetCountdown(limit, System.currentTimeMillis().toDouble())?.let { ", resets in $it" }.orEmpty()
            "$name ${limit.window.label.lowercase(Locale.ROOT)} is ${limit.status.label.lowercase(Locale.ROOT)}$time"
        } + "."
        loading -> "Reading live limits…"
        limits.none { it.status != LimitStatus.Unknown } -> "No fresh limits to check yet."
        else -> "No measured limits need attention right now."
    }
    val colors = Jarvis.colors
    val tone = attention.firstOrNull()?.let { limitColor(it.status) } ?: colors.accent2
    Surface(color = tone.copy(alpha = .10f), shape = MaterialTheme.shapes.medium) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("AT A GLANCE", style = MaterialTheme.typography.labelMedium,
                color = if (attention.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else tone)
            Text(summary, style = MaterialTheme.typography.titleMedium)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun UsageBackendTabs(computers: List<BackendConfig>, selectedKey: String?, select: (String?) -> Unit, modifier: Modifier = Modifier) {
    val backendTabs = listOf(null) + computers
    val selectedIndex = backendTabs.indexOfFirst { it?.key == selectedKey }.coerceAtLeast(0)
    PrimaryScrollableTabRow(selectedTabIndex = selectedIndex, modifier = modifier, edgePadding = 0.dp) {
        backendTabs.forEachIndexed { index, backend ->
            key(backend?.key) {
                Tab(selected = index == selectedIndex, onClick = { select(backend?.key) },
                    text = { Text(backend?.name ?: "All", maxLines = 1) })
            }
        }
    }
}

@Composable
internal fun LimitsSection(limits: List<GlanceLimit>, subscriptions: List<GlanceSubscription>, now: Double,
    modifier: Modifier, openSubscription: (SubscriptionIdentity) -> Unit, pauseBackends: List<BackendSession> = emptyList()) {
    var bySubscription by rememberSaveable { mutableStateOf(false) }
    var showingQuiet by rememberSaveable { mutableStateOf(false) }
    var expanded by remember { mutableStateOf<Pair<SubscriptionIdentity, String>?>(null) }
    val quiet = quietLimits(limits, now).map { it.key }.toSet()
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, itemVerticalAlignment = Alignment.CenterVertically) {
            GlanceHeading("Limits")
            FilterChip(selected = bySubscription, onClick = { bySubscription = !bySubscription }, label = { Text("By subscription") })
        }
        ValueNote(if (bySubscription) "Subscription windows grouped by plan" else "Closest first")
        if (limits.isEmpty()) ValueNote("No subscription windows to show.")
        subscriptions.flatMap { it.members }.forEach { (computer, reading) ->
            reading.error?.let { ValueNote("${reading.label} · ${computer.name}: Usage unavailable — $it") }
        }
        if (bySubscription) {
            subscriptions.forEach { subscription ->
                key(subscription.identity) {
                    TextButton(onClick = { openSubscription(subscription.identity) }) {
                        Text(listOfNotNull(subscription.latest.reading.label, subscription.latest.reading.plan).joinToString(" · "))
                        LucideGlyph(Lucide.ChevronRight, size = 16.dp)
                    }
                    val windows = limits.filter { it.subscription.identity == subscription.identity }
                    if (windows.isEmpty()) ValueNote("No windows reported.")
                    LimitCardGrid(windows) { limit ->
                        GlanceLimitCard(limit, now, expanded == limit.key, false, { expanded = limit.key.takeUnless { expanded == it } }, pauseBackends = pauseBackends)
                    }
                }
            }
        } else {
            LimitCardGrid(limits.filter { showingQuiet || it.key !in quiet }) { limit ->
                GlanceLimitCard(limit, now, expanded == limit.key, true, { expanded = limit.key.takeUnless { expanded == it } },
                    { openSubscription(limit.subscription.identity) }, pauseBackends)
            }
            if (quiet.isNotEmpty()) TextButton(onClick = { showingQuiet = !showingQuiet }) {
                Text(if (showingQuiet) "Hide quiet limits" else "${quiet.size} more ${if (quiet.size == 1) "limit" else "limits"}, all under 45%")
            }
        }
    }
}

@Composable
internal fun limitColor(status: LimitStatus) = when (status) {
    LimitStatus.Near -> Jarvis.colors.danger
    LimitStatus.Hot -> Jarvis.colors.warning
    LimitStatus.Room -> MaterialTheme.colorScheme.primary
    LimitStatus.Unknown -> MaterialTheme.colorScheme.onSurfaceVariant
}

@Composable
private fun LimitCardGrid(limits: List<GlanceLimit>, card: @Composable (GlanceLimit) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val columns = if (maxWidth >= 600.dp) 2 else 1
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            limits.chunked(columns).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { limit -> key(limit.key) { Box(Modifier.weight(1f)) { card(limit) } } }
                    if (row.size < columns) Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
internal fun GlanceLimitCard(limit: GlanceLimit, now: Double, expanded: Boolean, showProvider: Boolean,
    toggle: () -> Unit, openSubscription: (() -> Unit)? = null, pauseBackends: List<BackendSession> = emptyList()) {
    val reading = limit.subscription.latest.reading
    val color = limitColor(limit.status)
    val name = if (showProvider) "${reading.label} · ${limit.window.label}" else limit.window.label
    OutlinedCard(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth()
            .clickable(role = Role.Button, onClickLabel = if (expanded) "Hide limit details" else "Show limit details", onClick = toggle)
            .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
            .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(name, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
            LucideGlyph(if (expanded) Lucide.ChevronDown else Lucide.ChevronRight, size = 14.dp)
        }
        Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                UsageGauge(limit.window.usedPercent, limit.pace.elapsedShare.takeUnless { limit.stale }, color)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Surface(color = color.copy(alpha = .12f), shape = MaterialTheme.shapes.large) {
                        Text(if (limit.stale) "Last reading" else limit.status.label,
                            Modifier.padding(horizontal = 8.dp, vertical = 2.dp), style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.SemiBold, color = color)
                    }
                    ValueNote(if (limit.stale) "This reading is stale. Refresh to check the current pace." else paceDetail(limit.pace))
                    val resetsAt = limit.pace.resetsAt
                    ValueNote(when {
                        resetsAt == null -> "Reset time unknown"
                        resetsAt <= now -> "Reset due"
                        else -> "Resets in ${formatDuration(resetsAt - now)} · ${clockTime(resetsAt)}"
                    })
                }
            }
            HistoryChart(limit.window, limit.pace, now, color)
        }
        val computerKeys = limit.subscription.computers.map { it.key }
        FlowRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End)) {
            pauseBackends.filter { it.config.key in computerKeys }.forEach { backend -> key(backend.config.key) {
                val pauses by backend.usagePause.pauses.collectAsStateWithLifecycle()
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (pauses.orEmpty().any { it.providerLogin == reading.providerId }) ValueNote("Paused")
                    UsagePauseAction(backend, reading.providerId, reading.label, showComputer = computerKeys.size > 1)
                }
            } }
        }
        limitForecasts(limit, now).forEach { forecast ->
            Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 8.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp)) {
                ValueNote(if (computerKeys.size > 1) "${forecast.computer.name} · ${forecast.text}" else forecast.text)
                if (forecast.spenders.isNotEmpty()) ValueNote("Top spenders here · last 10 minutes · API value")
                forecast.spenders.forEach { spender ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("${spender.label} · ${spender.model}", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        ValueNote(usageMoney(spender.apiValue))
                    }
                }
            }
        }
        if (expanded) Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            HorizontalDivider()
            ValueNote("Chart: solid is used, dashed is even pace, and dotted is the window’s average pace continued. The dot marks now.")
            ValueNote(listOfNotNull(reading.account, computerNames(limit.subscription.computers)).joinToString(" · "))
            openSubscription?.let { TextButton(onClick = it) { Text("Open subscription") } }
        }
    }
}

@Composable
private fun <T> UsageFilters(choices: List<T>, selected: T, label: (T) -> String, select: (T) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        choices.forEach { choice -> FilterChip(selected = selected == choice, onClick = { select(choice) }, label = { Text(label(choice)) }) }
    }
}

internal fun computerNames(computers: List<BackendConfig>) = computers.joinToString(" · ") { it.name }

@Composable
internal fun SpendSection(period: UsagePeriod, selectPeriod: (UsagePeriod) -> Unit, recorded: List<Pair<BackendConfig, RecordedUsage>>,
    providerRows: List<SpendRow>, stats: List<Pair<BackendConfig, CacheStats>>, totalCost: Double,
    months: Map<Pair<SubscriptionIdentity, String?>, SubscriptionMonth>, loading: Boolean, monthLoading: Boolean,
    spendIncomplete: Boolean, monthComplete: Boolean, monthReadFailed: Boolean, modifier: Modifier, openSpend: (SpendRow) -> Unit) {
    var dimension by rememberSaveable { mutableStateOf(SpendDimension.Tasks) }
    var showingAll by rememberSaveable { mutableStateOf(false) }
    val ranked = spendRows(recorded, dimension)
    val unpriced = recorded.sumOf { it.second.totals.unpricedRequests }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        GlanceHeading("Spend")
        UsageFilters(UsagePeriod.entries, period, { it.label }, selectPeriod)
        if (loading && recorded.isEmpty()) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (spendIncomplete) ValueNote("Spend may be out of date or incomplete for some computers.")
        if (!loading && recorded.isEmpty()) ValueNote("Recorded spend is unavailable for this selection.")
        if (recorded.isNotEmpty()) {
            Text(usageMoney(totalCost), style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
            ValueNote("of work at API prices")
            if (period == UsagePeriod.Month) {
                val price = months.values.sumOf { it.price?.monthlyPrice ?: 0.0 }
                val work = months.values.sumOf { it.cost }
                when {
                    monthLoading && months.isEmpty() -> ValueNote("Reading monthly subscription prices…")
                    months.isNotEmpty() && monthComplete && months.values.all { it.price != null } && price > 0 ->
                        ValueNote("Subscriptions cost ${usageMoney(price)} a month. Subscription work at API prices is ${formatUsageRatio(work / price)}× that price.")
                    months.isNotEmpty() -> ValueNote("Partial comparison: ${usageMoney(work)} in subscription work and ${usageMoney(price)} in known monthly prices.")
                    else -> ValueNote("No monthly plan comparison available.")
                }
                if (monthReadFailed) ValueNote("Could not refresh monthly usage on every computer.")
                if (months.values.any { it.priceConflict }) ValueNote("Shared prices differ. The highest owner price, or highest default, is used.")
            }
            if (unpriced > 0) ValueNote("$unpriced requests had no catalog price.")
            if (recorded.any { it.second.approximate }) ValueNote("Older daily totals may cross a period boundary.")
            if (providerRows.isNotEmpty()) ProviderBreakdown(providerRows, stats, openSpend)
        }
        GlanceHeading("What cost most")
        UsageFilters(SpendDimension.entries, dimension, { it.label }) { dimension = it; showingAll = false }
        if (ranked.isEmpty() && recorded.isNotEmpty()) ValueNote("No ${dimension.label.lowercase(Locale.ROOT)} recorded for this period.")
        if (ranked.isNotEmpty()) OutlinedCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                (if (showingAll) ranked else ranked.take(5)).forEachIndexed { index, row ->
                    if (index > 0) HorizontalDivider()
                    UsageAmountRow(row.label, row.cost, note = computerNames(row.computers), onClick = { openSpend(row) })
                }
            }
        }
        if (ranked.size > 5) TextButton(onClick = { showingAll = !showingAll }) { Text(if (showingAll) "Show fewer" else "Show all ${ranked.size}") }
        if (stats.isNotEmpty()) ValueNote("Catalog rates estimate what this work would cost on the API, not what was charged.")
    }
}

@Composable
private fun ProviderBreakdown(rows: List<SpendRow>, stats: List<Pair<BackendConfig, CacheStats>>, openSpend: (SpendRow) -> Unit) {
    var showingProviders by rememberSaveable { mutableStateOf(false) }
    val accent = Jarvis.colors
    val colors = listOf(accent.accent1, accent.accent2, accent.accent3, accent.warning, MaterialTheme.colorScheme.tertiary)
    val total = rows.sumOf { it.cost }
    if (total > 0) Canvas(Modifier.fillMaxWidth().height(8.dp).semantics { contentDescription = "Work split by subscription and billing" }) {
        var start = 0f
        rows.forEachIndexed { index, row ->
            val width = size.width * (row.cost / total).toFloat()
            drawRect(colors[index % colors.size], Offset(start, 0f), Size(width, size.height))
            start += width
        }
    }
    TextButton(onClick = { showingProviders = !showingProviders }) { Text(if (showingProviders) "Hide by subscription and billing" else "Show by subscription and billing") }
    if (showingProviders) rows.forEachIndexed { index, row ->
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Canvas(Modifier.size(8.dp)) { drawCircle(colors[index % colors.size]) }
            val rate = apiKeySpendRate(row, stats)
            val note = listOfNotNull(computerNames(row.computers), rate?.let { "${usageMoney(it)}/h · last hour at API prices" }).joinToString("\n")
            UsageAmountRow(row.label, row.cost, note = note, onClick = { openSpend(row) })
        }
    }
}

@Composable
private fun PromptBilledAgain(stats: List<Pair<BackendConfig, CacheStats>>, computerCount: Int) {
    val reports = stats.map { it.second }
    val healthReports = stats.mapNotNull { (computer, report) -> report.cacheHealth?.let { computer to it } }
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        UsageAmountRow("Prompt billed again", reports.sumOf { it.totals.missedCost },
            note = "Estimated from inferred misses at API prices")
        if (healthReports.isNotEmpty()) {
            val cacheRead = reports.sumOf { it.totals.cacheReadTokens }
            val promptTokens = cacheRead + reports.sumOf { it.totals.inputTokens + it.totals.cacheWriteTokens }
            val share = if (reports.size == 1) healthReports.single().second.readShare
                else promptTokens.takeIf { it > 0 }?.let { cacheRead.toDouble() / it }
            val readShare = share?.let { "${(100 * it).roundToInt()}% of prompt tokens read from cache" } ?: "No prompt tokens"
            val attempts = healthReports.sumOf { it.second.keepWarmAttempts }
            val successes = healthReports.sumOf { it.second.keepWarmSuccesses }
            val pings = if (attempts > 0) "$successes/$attempts keep-warm pings succeeded" else "No keep-warm pings"
            val coverage = if (healthReports.size < computerCount) " · Ping coverage is partial" else ""
            ValueNote("Cache health: $readShare · $pings$coverage")
            healthReports.forEach { (computer, health) ->
                val reasons = listOfNotNull("Low cache reads".takeIf { health.lowReadShare },
                    "Miss cost rose sharply vs. the previous period".takeIf { health.missCostSpiked })
                if (reasons.isNotEmpty()) {
                    val name = if (computerCount > 1) "${computer.name}: " else ""
                    val warning = Jarvis.colors.warning
                    Row(Modifier.padding(top = 1.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Canvas(Modifier.padding(top = 5.dp).size(6.dp)) { drawCircle(warning) }
                        Text(name + reasons.joinToString(" · "), style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.Medium)
                    }
                }
            }
        }
    }
}

@Composable
internal fun WorthALook(stats: List<Pair<BackendConfig, CacheStats>>, computerCount: Int, loading: Boolean, modifier: Modifier) {
    var showingDiagnosis by rememberSaveable { mutableStateOf(false) }
    val reports = stats.map { it.second }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        GlanceHeading("Worth a look")
        ValueNote("Signals from retained request logs, not proof of waste.")
        if (reports.isEmpty()) ValueNote(if (loading) "Reading cache and request signals…" else "Cache and request signals are unavailable for this selection.")
        else {
            OutlinedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
                    PromptBilledAgain(stats, computerCount)
                    HorizontalDivider()
                    UsageAmountRow("Failed or stopped responses", reports.sumOf { it.usage?.failed?.cost ?: 0.0 }, note = "Only responses with reported usage")
                    HorizontalDivider()
                    UsageAmountRow("Keep-warm", reports.sumOf { it.keepWarm?.cost ?: 0.0 }, note = "Scheduled cache refreshes")
                    HorizontalDivider()
                    UsageAmountRow("Check-ins and retries", reports.sumOf { (it.usage?.checkIns?.cost ?: 0.0) + (it.usage?.retries?.cost ?: 0.0) }, note = "Requests themselves, not follow-up turns")
                }
            }
            TextButton(onClick = { showingDiagnosis = !showingDiagnosis }) { Text(if (showingDiagnosis) "Hide prompt-cache diagnosis" else "Show prompt-cache diagnosis") }
            if (showingDiagnosis) BoxWithConstraints {
                val wide = maxWidth >= 600.dp
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    stats.forEach { (computer, report) -> key(computer.key) {
                        Text(computer.name, style = MaterialTheme.typography.titleMedium)
                        CacheSection(report, wide)
                    } }
                }
            }
        }
    }
}
