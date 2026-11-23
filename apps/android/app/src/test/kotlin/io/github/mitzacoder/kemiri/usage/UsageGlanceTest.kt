package io.github.mitzacoder.kemiri.usage

import io.github.mitzacoder.kemiri.data.BackendConfig
import io.github.mitzacoder.kemiri.features.usage.*
import io.github.mitzacoder.kemiri.protocol.*
import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test

class UsageGlanceTest {
    private val studio = BackendConfig("Studio", "https://studio.example.test")
    private val workshop = BackendConfig("Workshop", "https://workshop.example.test")
    private val now = Instant.parse("2026-03-22T10:00:00Z")
    private val nowMillis = now.toEpochMilli().toDouble()

    @Test fun `forecast uses the server pace and stays quiet if the pace is missing stale or ends after reset`() {
        val forecast = UsageWindowForecast(minutesLeft = 50.0, minutesToReset = 230.0, validUntil = now.plusSeconds(300).toString(), spenders = emptyList())
        assertEquals("At this pace: runs out in 50 minutes, 3 hours before the reset", limitForecastText(forecast, nowMillis))
        assertEquals("At this pace: runs out in 1 hour 1 minute, 1 minute before the reset", limitForecastText(forecast.copy(minutesLeft = 61.0, minutesToReset = 61.2), nowMillis))
        assertNull(limitForecastText(forecast.copy(minutesLeft = 231.0), nowMillis))
        assertNull(limitForecastText(forecast, nowMillis + 300_000))
        assertNull(limitForecastText(null, nowMillis))
    }

    @Test fun `overview and detail have the same local calendar and rolling ranges`() {
        val zone = ZoneId.of("America/New_York")
        UsagePeriod.entries.forEach { period ->
            val range = usageRange(period, now, zone)
            val overview = range.overview()
            val details = range.detail(UsageSelectionProject(projectId = "example"))
            assertEquals(true, overview.recorded)
            assertEquals(overview.month, details.month)
            assertEquals(overview.days, details.days)
            assertEquals(overview.calendarToday, details.calendarToday)
            assertEquals(overview.utcOffsetMinutes, details.utcOffsetMinutes)
            assertEquals(if (period == UsagePeriod.Month) "2026-03" else null, overview.month)
            assertEquals(if (period == UsagePeriod.Month) -300L else -240L, overview.utcOffsetMinutes)
            assertEquals(period.days, overview.days)
            assertEquals(true.takeIf { period == UsagePeriod.Today }, overview.calendarToday)
        }
    }

    @Test fun `shared accounts use the newest reading per window and anonymous logins stay separate`() {
        val older = subscription("  Demo@example.test ", now.minusSeconds(60), window("week", 41.0), window("older only", 18.0))
        val newer = subscription("demo@example.test", now, window("week", 73.0))
        val merged = mergeSubscriptions(listOf(ComputerSubscription(studio, older), ComputerSubscription(workshop, newer)))
        assertEquals(1, merged.size)
        assertEquals(listOf(workshop, studio), merged.single().computers)
        assertEquals(listOf(73.0, 18.0), merged.single().windows.map { it.usedPercent })
        assertEquals(2, mergeSubscriptions(listOf(ComputerSubscription(studio, older.copy(account = null)),
            ComputerSubscription(workshop, newer.copy(account = null)))).size)
    }

    @Test fun `closest limits sort by percent and only extra quiet limits fold`() {
        val live = subscription("demo@example.test", now, window("room", 15.0), window("closest", 96.0),
            window("hot", 80.0), window("third", 52.0), window("fourth", 30.0), window("unknown", null))
        val oldReading = subscription(null, now.minusSeconds(1800), window("stale", 91.0))
        val readings = mergeSubscriptions(listOf(ComputerSubscription(studio, live), ComputerSubscription(workshop, oldReading)))
        val ranked = rankedLimits(readings, nowMillis)
        assertEquals(listOf("closest", "stale", "hot", "third", "fourth", "room", "unknown"), ranked.map { it.window.id })
        assertEquals(listOf(LimitStatus.Near, LimitStatus.Unknown, LimitStatus.Hot), ranked.take(3).map { it.status })
        assertTrue(ranked[1].stale)
        assertEquals(listOf("fourth", "room"), quietLimits(ranked, nowMillis).map { it.window.id })
    }

    @Test fun `project and task identities do not cross computers but models and callers aggregate`() {
        val reports = listOf(studio to spend(20.0), workshop to spend(30.0))
        assertEquals(listOf(30.0, 20.0), spendRows(reports, SpendDimension.Projects).map { it.cost })
        assertEquals(listOf(30.0, 20.0), spendRows(reports, SpendDimension.Tasks).map { it.cost })
        assertEquals(4, spendRows(reports, SpendDimension.Tasks, includeTaskless = true).size)
        val model = spendRows(reports, SpendDimension.Models).single()
        assertEquals(listOf(studio, workshop), model.computers)
        assertEquals(50.0, model.cost, 0.0)
        assertEquals(UsageSelectionModel(provider = "example", model = "model"), model.portions.first().selection)
        assertEquals(50.0, spendRows(reports, SpendDimension.Callers).single().cost, 0.0)
    }

    @Test fun `monthly comparison sums shared work but counts one owner price`() {
        val reading = subscription("demo@example.test", now)
        val subscriptions = mergeSubscriptions(listOf(ComputerSubscription(studio, reading), ComputerSubscription(workshop, reading)))
        val reports = listOf(studio to month(200.0, "default", 100.0), workshop to month(80.0, "owner", 40.0))
        val shared = subscriptionMonths(reports, subscriptions).values.single()
        assertEquals(280.0, shared.cost, 0.0)
        assertEquals(40.0, shared.price!!.monthlyPrice!!, 0.0)
        assertTrue(shared.priceConflict)
    }

    private fun window(id: String, percent: Double?) = UsageWindow(id = id, label = id, usedPercent = percent,
        resetsAt = now.plusSeconds(1800).toString(), windowMinutes = 60, samples = emptyList())

    private fun subscription(account: String?, updated: Instant, vararg windows: UsageWindow) = SubscriptionUsage(
        providerId = "example", label = "Example", plan = "Pro", account = account, windows = windows.toList(),
        source = "usage_api", updatedAt = updated.toString(), error = null)

    private fun spend(cost: Double): RecordedUsage {
        fun group(key: String, label: String) = RecordedUsageGroup(key, label, 1, 0.0, 0.0, 0.0, 0.0, cost, 0)
        return RecordedUsage(group("", ""), listOf(group("p1", "Project")),
            listOf(group("""["p1","T1"]""", "Task"), group("""["p1",null]""", "Coordinator")),
            listOf(group("""["example","model"]""", "example/model")), listOf(group("worker", "Worker")), emptyList(), false)
    }

    private fun month(cost: Double, kind: String, price: Double) = UsageValueResponse(id = "value", month = "2026-03",
        subscriptions = listOf(SubscriptionValue("example", "Example", "Pro", "subscription", SubscriptionPrice(kind, price, null, null),
            cost, null, null, null, emptyList(), emptyList(), emptyList(), assumed = false)),
        payAsYouGo = emptyList(), unpricedRequests = 0, assumed = false, approximateMonth = false, ledgerSince = null)
}
