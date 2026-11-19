package io.github.mitzacoder.kemiri.features.usage

import java.math.RoundingMode
import java.text.NumberFormat
import java.util.Locale
import kotlin.math.abs

/** Matches the web Value tab and task sheet, including amounts that round up to $100. */
internal fun usageMoney(amount: Double): String {
    if (amount > 0 && amount < 0.005) return "< $0.01"
    val digits = if (abs(amount) >= 99.995) 0 else 2
    return NumberFormat.getCurrencyInstance(Locale.US).apply {
        minimumFractionDigits = digits
        maximumFractionDigits = digits
        roundingMode = RoundingMode.HALF_UP
    }.format(amount)
}
