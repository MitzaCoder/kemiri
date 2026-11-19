package io.github.mitzacoder.kemiri.features.usage

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.BackendSession
import io.github.mitzacoder.kemiri.data.ConnectionStatus
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.protocol.SubscriptionsPriceSetRequest
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
internal fun SubscriptionValueScreen(backends: List<BackendSession>, openTask: (BackendSession, String, String) -> Unit) {
    val zone = ZoneId.systemDefault()
    val currentMonth = YearMonth.now(zone)
    var monthText by rememberSaveable { mutableStateOf(currentMonth.toString()) }
    val month = YearMonth.parse(monthText)
    val scroll = rememberScrollState()
    LaunchedEffect(month) { scroll.scrollTo(0) }
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
        Column(Modifier.widthIn(max = 672.dp).fillMaxWidth().padding(horizontal = 16.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { monthText = month.minusMonths(1).toString() }) {
                    LucideGlyph(Lucide.ChevronRight, Modifier.rotate(180f), contentDescription = "Previous month")
                }
                Text(month.format(DateTimeFormatter.ofPattern("LLLL yyyy")), Modifier.weight(1f).semantics { heading() },
                    style = MaterialTheme.typography.titleMedium, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                IconButton(enabled = month < currentMonth, onClick = { monthText = month.plusMonths(1).toString() }) {
                    LucideGlyph(Lucide.ChevronRight, contentDescription = "Next month")
                }
            }
        }
        Column(Modifier.widthIn(max = 672.dp).fillMaxWidth().weight(1f).verticalScroll(scroll).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp)) {
            backends.forEach { backend -> key(backend) {
                BackendSubscriptionValue(backend, month, currentMonth, zone) { projectId, taskId -> openTask(backend, projectId, taskId) }
            } }
        }
    }
}

@Composable
private fun BackendSubscriptionValue(
    backend: BackendSession, month: YearMonth, currentMonth: YearMonth, zone: ZoneId, openTask: (String, String) -> Unit,
) {
    val connection by backend.client.state.collectAsStateWithLifecycle()
    val projects by backend.projects.collectAsStateWithLifecycle()
    val ready = connection.status == ConnectionStatus.Ready
    val state = remember(backend, zone) { SubscriptionValueState { backend.client.request(valueMonthRequest(it, zone)) } }
    val storedReport by state.report.collectAsStateWithLifecycle()
    val visibleReport = storedReport.takeIf { it.month == month }
    val report = visibleReport?.report
    var refresh by remember { mutableIntStateOf(0) }
    LaunchedEffect(state, ready, connection.generation, month, refresh) { if (ready) state.load(month) }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(backend.config.name, Modifier.weight(1f).semantics { heading() }, style = MaterialTheme.typography.titleMedium)
            IconButton(enabled = ready && visibleReport?.reading != true, onClick = { refresh++ }) {
                LucideGlyph(io.github.mitzacoder.kemiri.features.settings.SettingsGlyphs.Refresh, contentDescription = "Refresh subscription value")
            }
        }
        if (!ready) ValueNote(if (report == null) "Waiting for the backend…" else "Backend disconnected. Showing the last report.")
        else if (visibleReport?.reading == true || visibleReport == null) LinearProgressIndicator(Modifier.fillMaxWidth())
        visibleReport?.error?.takeIf { ready }?.let {
            Text("Could not read subscription value: $it" + if (report == null) "" else " Showing the last report.",
                color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        if (report != null) {
            val (limited, noLimit) = report.subscriptions.partition { it.windows.isNotEmpty() }
            val card: @Composable (io.github.mitzacoder.kemiri.protocol.SubscriptionValue) -> Unit = { subscription ->
                key(month, subscription.providerId, subscription.billing) {
                    SubscriptionValueCard(subscription, editable = ready && month == currentMonth, openTask = openTask,
                        projectName = { id -> projects.firstOrNull { it.id == id }?.name ?: id },
                        savePrice = { price ->
                            backend.client.request(SubscriptionsPriceSetRequest(providerId = subscription.providerId, monthlyPrice = price),
                                explicitNulls = if (price == null) setOf("monthlyPrice") else emptySet())
                            refresh++
                        })
                }
            }
            limited.forEach { card(it) }
            if (report.payAsYouGo.isNotEmpty()) OutlinedCard(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ValueHeading("Paid at API prices")
                    ValueNote("Recorded API-key costs at catalog rates.")
                    report.payAsYouGo.forEach { UsageAmountRow(it.label, it.cost) }
                }
            }
            if (noLimit.isNotEmpty()) {
                ValueHeading("No limit reported")
                noLimit.forEach { card(it) }
            }
            if (report.subscriptions.isEmpty() && report.payAsYouGo.isEmpty()) ValueNote("No subscription or API-key usage recorded this month.")
            ValueNote(usageValueNotes(report, zone))
        }
    }
}
