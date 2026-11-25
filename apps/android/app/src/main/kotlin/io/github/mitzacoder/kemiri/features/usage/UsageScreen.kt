package io.github.mitzacoder.kemiri.features.usage

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import java.time.Instant
import java.time.YearMonth
import java.time.ZoneId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

private sealed interface UsageSheet {
    data class Subscription(val identity: SubscriptionIdentity) : UsageSheet
    data class Spend(val row: SpendRow, val range: UsageRange, val totalCost: Double) : UsageSheet
}

internal data class UsageRead<T>(val report: T? = null, val loading: Boolean = false, val error: String? = null)

internal suspend fun <T> readUsage(read: suspend () -> T): UsageRead<T> = try {
    UsageRead(report = read())
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (error: Exception) {
    UsageRead(error = error.message ?: "Request failed")
}

@Composable
private fun <T> observeUsageRead(supported: Boolean, ready: Boolean, generation: Int, query: Any, refresh: Int, read: suspend () -> T): UsageRead<T> {
    val owner = LocalLifecycleOwner.current
    // A new socket triggers a read, not a new report scope. Only a different query or lost support invalidates it.
    var result by remember(query, supported) { mutableStateOf(UsageRead<T>(loading = supported && ready)) }
    LaunchedEffect(owner, query, supported, ready, generation, refresh) {
        if (supported && ready) owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            result = result.copy(loading = true, error = null)
            val answer = readUsage(read)
            result = answer.copy(report = answer.report ?: result.report)
        }
    }
    return if (ready) result else result.copy(loading = false)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UsageScreen(repository: HarnessRepository, modifier: Modifier = Modifier, navigate: (Destination) -> Unit) {
    val sessions by repository.sessions.collectAsStateWithLifecycle()
    val settings by repository.settings.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val owner = LocalLifecycleOwner.current
    var now by remember { mutableStateOf(Instant.now()) }
    LaunchedEffect(owner) { owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
        while (true) {
            now = Instant.now()
            delay(15_000)
        }
    } }
    val zone = ZoneId.systemDefault()
    val month = YearMonth.from(now.atZone(zone))
    val nowMillis = now.toEpochMilli().toDouble()
    val computer = sessions.firstOrNull { it.config.key == settings.usageComputerKey }
    val selected = computer?.let { listOf(it) } ?: sessions
    var period by rememberSaveable { mutableStateOf(UsagePeriod.Rolling) }
    val range = usageRange(period, now, zone)
    // Today must refresh at local midnight even when its wire fields have not changed.
    val overviewQuery = range to now.atZone(zone).toLocalDate().takeIf { period == UsagePeriod.Today }
    var refresh by remember { mutableIntStateOf(0) }
    var sheets by remember(sessions, computer) { mutableStateOf(emptyList<UsageSheet>()) }
    val sheet = sheets.lastOrNull()
    val needsMonth = period == UsagePeriod.Month || sheets.any { it is UsageSheet.Subscription }
    val watches = sessions.map { backend -> key(backend) { backend to remember { UsageWatch(backend.client) } } }.toMap()
    val computers = selected.map { backend -> key(backend) {
        val watch = watches.getValue(backend)
        val connection by backend.client.state.collectAsStateWithLifecycle()
        val limits by watch.state.collectAsStateWithLifecycle()
        LaunchedEffect(owner, watch) { owner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { watch.observe() } }
        val ready = connection.status == ConnectionStatus.Ready
        val supportsRecorded = connection.supports(HarnessFeature.RECORDED_USAGE)
        val stats = observeUsageRead(supportsRecorded, ready, connection.generation, overviewQuery, refresh) {
            backend.client.request(range.overview(connection.supports(HarnessFeature.CACHE_HEALTH))).stats
        }
        val monthly = observeUsageRead(needsMonth && connection.supports(HarnessFeature.SUBSCRIPTION_VALUE), ready,
            connection.generation, month to zone, refresh) {
            backend.client.request(valueMonthRequest(month, zone)).also {
                check(it.month == month.toString()) { "The computer returned a different month." }
            }
        }
        GlanceComputer(backend, ready, supportsRecorded, limits, stats, monthly)
    } }
    fun subscriptionsFrom(computers: List<GlanceComputer>) = mergeSubscriptions(computers.flatMap { computerRead ->
        computerRead.limits.subscriptions.map { ComputerSubscription(computerRead.backend.config, it) }
    })
    // Keep the cards above Spend in place during a reconnect, but base attention on connected computers only.
    val subscriptions = subscriptionsFrom(computers)
    val limits = rankedLimits(subscriptions, nowMillis)
    val liveLimits = rankedLimits(subscriptionsFrom(computers.filter { it.ready }), nowMillis)
    val stats = computers.mapNotNull { read -> read.stats.report?.let { read.backend.config to it } }
    val recorded = stats.mapNotNull { (config, report) -> report.recorded?.let { config to it } }
    val months = subscriptionMonths(computers.mapNotNull { read -> read.monthly.report?.let { read.backend.config to it } }, subscriptions)
    val totalCost = recorded.sumOf { it.second.totals.cost }
    val subscriptionSpend = providerSpend(recorded, subscriptions)
    val spendIncomplete = computers.any { !it.ready || !it.supportsRecorded || it.stats.error != null || (it.stats.report != null && it.stats.report.recorded == null) }
    val readingSpend = computers.any { it.stats.loading }
    val refreshing = computers.any { it.limits.loading || it.stats.loading || it.monthly.loading }
    fun refreshUsage() {
        selected.forEach { backend -> if (backend.client.state.value.status == ConnectionStatus.Ready) watches.getValue(backend).refresh() }
        refresh++
    }
    fun openTask(computerConfig: BackendConfig, projectId: String, taskId: String) {
        sheets = emptyList()
        navigate(Destination.Task(Destination.Chat(computerConfig.key, projectId), taskId))
    }
    val scroll = rememberScrollState()
    val sectionOffsets = remember { mutableStateMapOf<String, Int>() }
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 720.dp).fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                UsageBackendTabs(sessions.map { it.config }, computer?.config?.key, modifier = Modifier.weight(1f), select = { key ->
                    if (key != computer?.config?.key) {
                        sheets = emptyList()
                        scope.launch { repository.setUsageComputer(key) }
                    }
                })
                IconButton(onClick = ::refreshUsage, enabled = !refreshing && computers.any { it.ready }) {
                    LucideGlyph(io.github.mitzacoder.kemiri.features.settings.SettingsGlyphs.Refresh, contentDescription = "Refresh usage")
                }
            }
            PullToRefreshBox(isRefreshing = refreshing, onRefresh = { if (!refreshing) refreshUsage() },
                modifier = Modifier.weight(1f).fillMaxWidth()) {
                Column(Modifier.fillMaxSize().verticalScroll(scroll).padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    AttentionSummary(liveLimits, computers.any { it.limits.loading })
                    if (sessions.isEmpty()) ValueNote("Add a computer in Settings to see its usage.")
                    else {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            listOf("Limits", "Spend", "Worth a look").forEach { heading ->
                                TextButton(onClick = { scope.launch { sectionOffsets[heading]?.let { scroll.animateScrollTo(it) } } },
                                    contentPadding = PaddingValues(horizontal = 8.dp)) { Text(heading) }
                            }
                        }
                        computers.filterNot { it.ready }.forEach { computer ->
                            val cached = computer.limits.subscriptions.isNotEmpty() || computer.stats.report != null
                            ValueNote("${computer.backend.config.name} is not connected." + if (cached) " Showing the last readings." else "")
                        }
                        computers.forEach { read -> read.limits.error?.let { ValueNote("${read.backend.config.name}: limits could not refresh. $it") } }
                        LimitsSection(limits, subscriptions, nowMillis, Modifier.onGloballyPositioned { sectionOffsets["Limits"] = it.positionInParent().y.roundToInt() },
                            openSubscription = { sheets = listOf(UsageSheet.Subscription(it)) }, pauseBackends = selected)
                        SpendSection(period, { period = it }, recorded, subscriptionSpend, stats, totalCost, months,
                            loading = readingSpend, monthLoading = computers.any { it.monthly.loading },
                            spendIncomplete = spendIncomplete, monthComplete = computers.all { it.monthly.report != null && it.stats.report?.recorded != null },
                            monthReadFailed = computers.any { it.monthly.error != null },
                            modifier = Modifier.onGloballyPositioned { sectionOffsets["Spend"] = it.positionInParent().y.roundToInt() },
                            openSpend = { row -> sheets = listOf(row.subscription?.let { UsageSheet.Subscription(it) } ?: UsageSheet.Spend(row, range, totalCost)) })
                        WorthALook(stats, computers.size, readingSpend, Modifier.onGloballyPositioned { sectionOffsets["Worth a look"] = it.positionInParent().y.roundToInt() })
                    }
                }
            }
        }
    }
    if (sheet != null) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(onDismissRequest = { sheets = emptyList() }, sheetState = sheetState) {
            key(sheet) {
                Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (sheets.size > 1) TextButton(onClick = { sheets = sheets.dropLast(1) }) { Text("Back to breakdown") }
                    when (sheet) {
                        is UsageSheet.Subscription -> subscriptions.firstOrNull { it.identity == sheet.identity }?.let { subscription ->
                            SubscriptionGlanceSheet(subscription, months[sheet.identity to null], limits.filter { it.subscription.identity == sheet.identity },
                                computers.filter { read -> subscription.computers.any { it.key == read.backend.config.key } }, nowMillis,
                                refreshLimits = { watches[it]?.refresh() }, openTask = ::openTask)
                        } ?: ValueNote("This subscription is not connected.")
                        is UsageSheet.Spend -> SpendGlanceSheet(sheet.row, sheet.range, sheet.totalCost, selected, ::openTask) { row ->
                            sheets = sheets + UsageSheet.Spend(row, sheet.range, sheet.totalCost)
                        }
                    }
                    TextButton(onClick = { sheets = emptyList() }) { Text("Close") }
                }
            }
        }
    }
}

internal data class GlanceComputer(
    val backend: BackendSession, val ready: Boolean, val supportsRecorded: Boolean, val limits: UsageState,
    val stats: UsageRead<CacheStats>, val monthly: UsageRead<UsageValueResponse>,
)
