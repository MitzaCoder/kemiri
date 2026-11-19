package io.github.mitzacoder.kemiri.features.usage

import io.github.mitzacoder.kemiri.protocol.UsageValueResponse
import java.time.YearMonth
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

internal data class SubscriptionValueReport(
    val month: YearMonth? = null,
    val report: UsageValueResponse? = null,
    val reading: Boolean = false,
    val error: String? = null,
)

/** State for one backend's Value tab, confined to the screen's dispatcher. */
internal class SubscriptionValueState(private val read: suspend (YearMonth) -> UsageValueResponse) {
    private val mutableReport = MutableStateFlow(SubscriptionValueReport())
    val report = mutableReport.asStateFlow()
    private var readVersion = 0L

    fun showMonth(month: YearMonth): SubscriptionValueReport = report.value.takeIf { it.month == month } ?: SubscriptionValueReport(month)

    suspend fun load(month: YearMonth) {
        val version = ++readVersion
        val previous = showMonth(month).report
        mutableReport.value = SubscriptionValueReport(month, previous, reading = true)
        try {
            val received = read(month)
            currentCoroutineContext().ensureActive()
            check(received.month == month.toString()) { "The backend returned a different month." }
            if (readVersion == version) mutableReport.value = SubscriptionValueReport(month, received)
        } catch (cancelled: CancellationException) {
            if (readVersion == version) mutableReport.value = SubscriptionValueReport(month, previous)
            throw cancelled
        } catch (cause: Exception) {
            if (readVersion == version) mutableReport.value = SubscriptionValueReport(month, previous, error = cause.message ?: "Request failed")
        }
    }
}
