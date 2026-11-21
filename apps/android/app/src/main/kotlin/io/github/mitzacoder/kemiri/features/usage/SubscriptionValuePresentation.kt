package io.github.mitzacoder.kemiri.features.usage

import io.github.mitzacoder.kemiri.protocol.UsageValueRequest
import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import java.text.NumberFormat
import java.time.YearMonth
import java.time.ZoneId
import java.util.Locale

internal fun formatUsageRatio(ratio: Double): String = NumberFormat.getNumberInstance(Locale.US).apply {
    maximumFractionDigits = 340
}.format(BigDecimal.valueOf(ratio).round(MathContext(2, RoundingMode.HALF_UP)))

internal fun usagePercent(share: Double?): String = share?.let {
    NumberFormat.getPercentInstance(Locale.US).apply { roundingMode = RoundingMode.HALF_UP }.format(it)
} ?: "Not measured"

internal fun valueMonthRequest(month: YearMonth, zone: ZoneId): UsageValueRequest = UsageValueRequest(
    month = month.toString(), utcOffsetMinutes = month.atDay(1).atStartOfDay(zone).offset.totalSeconds / 60L,
)

internal fun monthlyPriceFromInput(text: String): Double? = text.trim().replace(',', '.').toDoubleOrNull()
    ?.takeIf { it.isFinite() && it > 0 }
