package io.github.mitzacoder.kemiri.features.usage

import io.github.mitzacoder.kemiri.data.BackendConfig
import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.protocol.*
import java.time.Instant
import java.time.YearMonth
import java.time.ZoneId
import java.util.Locale
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

internal enum class UsagePeriod(val label: String, val days: Long?) {
    Today("Today", 1), Week("7 days", 7), Rolling("30 days", 30), Month("This month", null),
}

/** The overview and its sheets share these exact range fields. */
internal data class UsageRange(val period: UsagePeriod, val month: String?, val utcOffsetMinutes: Long) {
    private val calendarToday get() = true.takeIf { period == UsagePeriod.Today }

    fun overview() = CacheStatsRequest(month = month, days = period.days, calendarToday = calendarToday,
        utcOffsetMinutes = utcOffsetMinutes, recorded = true)

    fun detail(selection: UsageSelection) = UsageDetailRequest(month = month, days = period.days,
        calendarToday = calendarToday, utcOffsetMinutes = utcOffsetMinutes, selection = selection)
}

internal fun usageRange(period: UsagePeriod, now: Instant, zone: ZoneId): UsageRange {
    val month = YearMonth.from(now.atZone(zone)).takeIf { period == UsagePeriod.Month }
    val offset = month?.atDay(1)?.atStartOfDay(zone)?.offset ?: zone.rules.getOffset(now)
    return UsageRange(period, month?.toString(), offset.totalSeconds / 60L)
}

internal data class ComputerSubscription(val computer: BackendConfig, val reading: SubscriptionUsage)
internal data class SubscriptionIdentity(val provider: String, val account: String?, val plan: String?, val computerKey: String?)
internal data class GlanceSubscription(val identity: SubscriptionIdentity, val members: List<ComputerSubscription>) {
    val latest get() = members.first()
    val windows get() = members.flatMap { it.reading.windows }.distinctBy { it.id }
    val computers get() = members.map { it.computer }.distinctBy { it.key }
}

internal fun mergeSubscriptions(readings: List<ComputerSubscription>): List<GlanceSubscription> = readings.groupBy { (computer, reading) ->
    val account = reading.account?.trim()?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() }
    SubscriptionIdentity(reading.providerId, account, reading.plan.takeIf { account != null }, computer.key.takeIf { account == null })
}.map { (identity, members) -> GlanceSubscription(identity, members.sortedByDescending { parseTime(it.reading.updatedAt) }) }

internal enum class LimitStatus(val label: String) {
    Near("Nearly out"), Hot("Running hot"), Room("Room to spare"), Unknown("Not measured"),
}

internal data class GlanceLimit(val subscription: GlanceSubscription, val window: UsageWindow, val pace: WindowPace, val status: LimitStatus, val stale: Boolean) {
    val key get() = subscription.identity to window.id
}

internal fun rankedLimits(subscriptions: List<GlanceSubscription>, now: Double): List<GlanceLimit> = subscriptions.flatMap { subscription ->
    subscription.windows.map { window ->
        val pace = windowPace(window, now)
        val reading = subscription.members.first { member -> member.reading.windows.any { it.id == window.id } }.reading
        val stale = parseTime(reading.updatedAt)?.let { now - it > 15 * 60_000 } == true || pace.resetsAt?.let { now >= it } == true
        val status = when {
            window.usedPercent == null || stale -> LimitStatus.Unknown
            window.usedPercent >= 90 -> LimitStatus.Near
            pace.kind == PaceKind.Ahead && !pace.early -> LimitStatus.Hot
            else -> LimitStatus.Room
        }
        GlanceLimit(subscription, window, pace, status, stale)
    }
}.sortedWith(compareByDescending<GlanceLimit> { it.window.usedPercent ?: -1.0 }.thenBy { it.pace.resetsAt ?: Double.POSITIVE_INFINITY })

internal fun quietLimits(limits: List<GlanceLimit>) = limits.drop(4).filter { it.status == LimitStatus.Room && (it.window.usedPercent ?: 100.0) < 45 }

internal enum class SpendDimension(val label: String, val kind: String, val groups: (RecordedUsage) -> List<RecordedUsageGroup>) {
    Tasks("Tasks", "task", { it.byTask }), Projects("Projects", "project", { it.byProject }),
    Models("Models", "model", { it.byModel }), Callers("Who called", "role", { it.byRole }),
}

internal data class SpendPortion(val computer: BackendConfig, val group: RecordedUsageGroup, val selection: UsageSelection?)
internal data class SpendRow(val label: String, val portions: List<SpendPortion>, val subscription: SubscriptionIdentity? = null) {
    val cost get() = portions.sumOf { it.group.cost }
    val computers get() = portions.map { it.computer }.distinctBy { it.key }
}

private fun usageKey(key: String): Pair<String, String?>? = runCatching {
    val (first, second) = wireJson.parseToJsonElement(key).jsonArray
    require(first != JsonNull)
    first.jsonPrimitive.content to second.jsonPrimitive.contentOrNull
}.getOrNull()

internal fun spendRows(reports: List<Pair<BackendConfig, RecordedUsage>>, dimension: SpendDimension, includeTaskless: Boolean = false): List<SpendRow> {
    val portions = reports.flatMap { (computer, usage) -> dimension.groups(usage).mapNotNull { group ->
        val selection = when (dimension) {
            SpendDimension.Tasks -> {
                val (project, task) = usageKey(group.key) ?: return@mapNotNull null
                if (task == null && !includeTaskless) return@mapNotNull null
                task?.let { UsageSelectionTask(projectId = project, taskId = it) }
            }
            SpendDimension.Projects -> UsageSelectionProject(projectId = group.key)
            SpendDimension.Models -> {
                val (provider, model) = usageKey(group.key) ?: return@mapNotNull null
                UsageSelectionModel(provider = provider, model = model ?: return@mapNotNull null)
            }
            SpendDimension.Callers -> UsageSelectionRole(role = group.key)
        }
        SpendPortion(computer, group, selection)
    } }
    val localIdentity = dimension == SpendDimension.Tasks || dimension == SpendDimension.Projects
    return portions.groupBy { it.computer.key.takeIf { localIdentity } to it.group.key }.values.map { members ->
        val first = members.first()
        SpendRow((first.selection as? UsageSelectionModel)?.model ?: first.group.label, members)
    }.sortedWith(compareByDescending<SpendRow> { it.cost }.thenBy { it.label })
}

internal fun providerSpend(reports: List<Pair<BackendConfig, RecordedUsage>>, subscriptions: List<GlanceSubscription>): List<SpendRow> {
    val portions = reports.flatMap { (computer, usage) -> usage.byProviderBilling.mapNotNull { group ->
        val (provider, billing) = usageKey(group.key) ?: return@mapNotNull null
        val matching = matchingSubscription(subscriptions, computer, provider)
        val covering = matching.takeIf { billing == "subscription" || billing == "plan_key" }
        val name = matching?.latest?.reading?.label ?: provider
        val label = if (covering != null) name else "$name · " + when (billing) {
            "api_key" -> "API key"
            "agent" -> "External agent"
            null -> "Billing unknown"
            else -> "Subscription"
        }
        Triple(covering?.identity, label, SpendPortion(computer, group, UsageSelectionProviderBilling(provider = provider, billing = billing)))
    } }
    return portions.groupBy { (subscription, _, portion) -> subscription to portion.group.key.takeIf { subscription == null } }.values.map { members ->
        SpendRow(members.first().second, members.map { it.third }, members.first().first)
    }.sortedByDescending { it.cost }
}

private fun matchingSubscription(subscriptions: List<GlanceSubscription>, computer: BackendConfig, provider: String) =
    subscriptions.firstOrNull { it.identity.provider == provider && it.computers.any { member -> member.key == computer.key } }

internal data class SubscriptionMonth(val portions: List<Pair<BackendConfig, SubscriptionValue>>) {
    val cost get() = portions.sumOf { it.second.apiValue }
    private val prices get() = portions.map { it.second.price }.filter { it.monthlyPrice != null }
    val price get() = prices.maxWithOrNull(compareBy<SubscriptionPrice> { it.kind == "owner" }.thenBy { it.monthlyPrice })
    val priceConflict get() = prices.map { it.monthlyPrice }.distinct().size > 1
}

internal fun subscriptionMonths(reports: List<Pair<BackendConfig, UsageValueResponse>>, subscriptions: List<GlanceSubscription>): Map<Pair<SubscriptionIdentity, String?>, SubscriptionMonth> =
    reports.flatMap { (computer, report) -> report.subscriptions.filter { it.billing != "agent" }.map { computer to it } }
        .groupBy { (computer, value) ->
            val matching = matchingSubscription(subscriptions, computer, value.providerId)
            (matching?.identity ?: SubscriptionIdentity(value.providerId, null, null, computer.key)) to value.billing.takeIf { matching == null }
        }.mapValues { SubscriptionMonth(it.value) }
