package io.github.mitzacoder.kemiri.usage

import io.github.mitzacoder.kemiri.features.usage.*
import java.time.YearMonth
import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test

class SubscriptionValueTest {
    @Test fun `money matches the web thresholds and grouping`() {
        for ((amount, text) in listOf(1640.0 to "$1,640", 100.0 to "$100", 99.995 to "$100", 99.99 to "$99.99",
            42.5 to "$42.50", 35.0 to "$35.00", 0.005 to "$0.01", 0.001 to "< $0.01", 0.0 to "$0.00")) {
            assertEquals(text, usageMoney(amount))
        }
    }

    @Test fun `ratios use two significant digits`() {
        assertEquals("16", formatUsageRatio(16.4))
        assertEquals("1.3", formatUsageRatio(1.25))
        assertEquals("0.018", formatUsageRatio(.01832))
        assertEquals("Not measured", usagePercent(null))
        assertEquals("62%", usagePercent(.62))
    }

    @Test fun `month requests use the offset at the start of the chosen month`() {
        val zone = ZoneId.of("America/New_York")
        val december = YearMonth.of(2025, 12)
        assertEquals("2026-01", valueMonthRequest(december.plusMonths(1), zone).month)
        assertEquals(-300L, valueMonthRequest(december, zone).utcOffsetMinutes)
        assertEquals(-240L, valueMonthRequest(YearMonth.of(2026, 7), zone).utcOffsetMinutes)
        assertEquals(345L, valueMonthRequest(december, ZoneId.of("Asia/Kathmandu")).utcOffsetMinutes)
    }

    @Test fun `price entry rejects missing zero negative and nonfinite amounts`() {
        listOf("", "0", "-1", "NaN", "Infinity").forEach { assertNull(monthlyPriceFromInput(it)) }
        assertEquals(42.5, monthlyPriceFromInput("42.50"))
        assertEquals(42.5, monthlyPriceFromInput("42,50"))
    }
}
