package io.github.mitzacoder.kemiri.usage

import io.github.mitzacoder.kemiri.features.usage.*
import io.github.mitzacoder.kemiri.protocol.*
import java.time.YearMonth
import java.time.ZoneId
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SubscriptionValueTest {
    @Test fun `money matches the web thresholds and grouping`() {
        for ((amount, text) in listOf(1640.0 to "$1,640", 100.0 to "$100", 99.995 to "$100", 99.99 to "$99.99",
            42.5 to "$42.50", 35.0 to "$35.00", 0.005 to "$0.01", 0.001 to "< $0.01", 0.0 to "$0.00")) {
            assertEquals(text, usageMoney(amount))
        }
    }

    @Test fun `ratios use two significant digits and ranges disclose an open upper bound`() {
        assertEquals("16", formatUsageRatio(16.4))
        assertEquals("1.3", formatUsageRatio(1.25))
        assertEquals("0.018", formatUsageRatio(.01832))
        assertEquals("range $560–$670", usageRange(ValueRange(610.0, 560.0, 670.0)))
        assertEquals("range $4.20 and up", usageRange(ValueRange(5.0, 4.2, null)))
        assertEquals("Not measured", usagePercent(null))
        assertEquals("62%", usagePercent(.62))
    }

    @Test fun `the headline leads with work and offers price entry only when needed`() {
        val subscription = SubscriptionValue("orchard-example", "Orchard", null, "subscription",
            SubscriptionPrice("default", 100.0, "2026-01-01", "https://example.test/pricing"), 1640.0, 16.4,
            25.0, .62, emptyList(), emptyList(), emptyList(), assumed = false)
        assertEquals(SubscriptionHeadline("$1,640 of work for $100.", "16× what this subscription costs.", "Change price"), subscriptionHeadline(subscription))
        assertEquals(SubscriptionHeadline("$1,640 of work.", null, "Add what you pay"),
            subscriptionHeadline(subscription.copy(price = SubscriptionPrice("none", null, null, null), realisedRatio = null)))
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

    @Test fun `a failed refresh keeps only the selected month's last report`() = runTest {
        val month = YearMonth.of(2026, 2)
        var fail = false
        val state = SubscriptionValueState { if (fail) error("offline") else report(it) }
        state.load(month)
        assertEquals(report(month), state.report.value.report)
        assertNull(state.showMonth(month.minusMonths(1)).report)
        fail = true
        state.load(month)
        assertEquals(report(month), state.report.value.report)
        assertEquals("offline", state.report.value.error)
        state.load(month.minusMonths(1))
        assertNull(state.report.value.report)
        assertFalse(state.report.value.reading)
    }

    @Test fun `an older in-flight report cannot replace the selected month`() = runTest {
        val month = YearMonth.of(2026, 2)
        val deferred = CompletableDeferred<UsageValueResponse>()
        val previous = month.minusMonths(1)
        val state = SubscriptionValueState { if (it == previous) deferred.await() else report(it) }
        launch { state.load(previous) }
        runCurrent()
        assertTrue(state.report.value.reading)
        state.load(month)
        deferred.complete(report(previous))
        runCurrent()
        assertEquals(report(month), state.report.value.report)
        assertFalse(state.report.value.reading)
    }

    @Test fun `cancelling a refresh clears loading without turning it into an error`() = runTest {
        val month = YearMonth.of(2026, 2)
        var stall = false
        val state = SubscriptionValueState { if (stall) CompletableDeferred<UsageValueResponse>().await() else report(it) }
        state.load(month)
        stall = true
        val refresh = launch { state.load(month) }
        runCurrent()
        refresh.cancel()
        runCurrent()
        assertEquals(report(month), state.report.value.report)
        assertNull(state.report.value.error)
        assertFalse(state.report.value.reading)
    }

    private fun report(month: YearMonth) = UsageValueResponse(id = "value", month = month.toString(), subscriptions = emptyList(),
        payAsYouGo = emptyList(), unpricedRequests = 0, assumed = false, approximateMonth = false, ledgerSince = null)
}
