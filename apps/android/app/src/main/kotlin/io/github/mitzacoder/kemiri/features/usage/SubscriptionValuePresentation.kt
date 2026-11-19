package io.github.mitzacoder.kemiri.features.usage

import io.github.mitzacoder.kemiri.protocol.SubscriptionValue
import io.github.mitzacoder.kemiri.protocol.UsageValueRequest
import io.github.mitzacoder.kemiri.protocol.UsageValueResponse
import io.github.mitzacoder.kemiri.protocol.ValueRange
import io.github.mitzacoder.kemiri.protocol.WindowValue
import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import java.text.NumberFormat
import java.time.Instant
import java.time.YearMonth
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

internal data class SubscriptionHeadline(val work: String, val comparison: String?, val priceAction: String)

internal fun subscriptionHeadline(subscription: SubscriptionValue): SubscriptionHeadline {
    val work = usageMoney(subscription.apiValue)
    val price = subscription.price.monthlyPrice
    val ratio = subscription.realisedRatio
    return if (price == null || ratio == null) SubscriptionHeadline("$work of work.", null, "Add what you pay")
    else SubscriptionHeadline("$work of work for ${usageMoney(price)}.", "${formatUsageRatio(ratio)}× what this subscription costs.", "Change price")
}

internal fun formatUsageRatio(ratio: Double): String = NumberFormat.getNumberInstance(Locale.US).apply {
    maximumFractionDigits = 340
}.format(BigDecimal.valueOf(ratio).round(MathContext(2, RoundingMode.HALF_UP)))

internal fun usageRange(range: ValueRange): String = "range ${usageMoney(range.low)}" +
    (range.high?.let { "–${usageMoney(it)}" } ?: " and up")

internal fun usagePercent(share: Double?): String = share?.let {
    NumberFormat.getPercentInstance(Locale.US).apply { roundingMode = RoundingMode.HALF_UP }.format(it)
} ?: "Not measured"

internal fun fullWindowLabel(window: WindowValue): String = when (window.windowMinutes) {
    10_080.0 -> "Full week"
    43_200.0 -> "Full month"
    else -> "Full window · ${window.label}"
}

internal fun valueMonthRequest(month: YearMonth, zone: ZoneId): UsageValueRequest = UsageValueRequest(
    month = month.toString(), utcOffsetMinutes = month.atDay(1).atStartOfDay(zone).offset.totalSeconds / 60L,
)

internal fun monthlyPriceFromInput(text: String): Double? = text.trim().replace(',', '.').toDoubleOrNull()
    ?.takeIf { it.isFinite() && it > 0 }

internal fun usageValueNotes(report: UsageValueResponse, zone: ZoneId): String = buildString {
    append("API value adds up recorded requests at catalog rates, not invoice prices. Plan use, full use and points used elsewhere are estimates from observed limit changes")
    report.ledgerSince?.let { since ->
        runCatching { Instant.parse(since).atZone(zone).toLocalDate() }.getOrNull()?.let {
            append(" since ${it.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))}")
        }
    }
    append('.')
    if (report.assumed) append(" Billing for older requests was assumed from backend credentials.")
    if (report.approximateMonth) append(" Older daily totals may cross a local month boundary.")
    if (report.unpricedRequests > 0) {
        val count = NumberFormat.getIntegerInstance(Locale.US).format(report.unpricedRequests)
        append(" $count ${if (report.unpricedRequests == 1L) "request had" else "requests had"} no catalog price.")
    }
}
