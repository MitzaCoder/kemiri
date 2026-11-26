package io.github.mitzacoder.kemiri.features.notifications

import android.app.Notification
import android.content.Context
import androidx.core.app.NotificationCompat
import io.github.mitzacoder.kemiri.protocol.NotificationPayload
import java.time.Instant

private const val EXTRA_REPORTED_NAMES = "kemiri.limitComputerNames"
private const val EXTRA_REPORTED_COMPUTERS = "kemiri.limitComputers"

internal data class SharedLimitCard(val tag: String, val expiresAt: Instant) {
    fun previousComputers(notification: Notification?): Map<String, String> {
        val keys = notification?.extras?.getStringArrayList(EXTRA_REPORTED_COMPUTERS).orEmpty()
        val names = notification?.extras?.getStringArrayList(EXTRA_REPORTED_NAMES).orEmpty()
        return keys.mapIndexed { index, key -> key to names.getOrElse(index) { "" } }.toMap()
    }

    fun announced(context: Context, now: Instant): Boolean =
        context.getSharedPreferences("shared-limit-notices", Context.MODE_PRIVATE).getLong(tag, 0) > now.toEpochMilli()

    fun remember(context: Context, now: Instant) {
        val receipts = context.getSharedPreferences("shared-limit-notices", Context.MODE_PRIVATE)
        val edit = receipts.edit()
        receipts.all.forEach { (key, end) -> if (end is Long && end <= now.toEpochMilli()) edit.remove(key) }
        edit.putLong(tag, expiresAt.toEpochMilli()).apply()
    }

    fun saveComputers(builder: NotificationCompat.Builder, computers: Map<String, String>, showDetails: Boolean) {
        builder.extras.putStringArrayList(EXTRA_REPORTED_COMPUTERS, ArrayList(computers.keys))
        if (showDetails) builder.extras.putStringArrayList(EXTRA_REPORTED_NAMES, ArrayList(computers.values))
    }
}

/** No reset, no identity guess. A notification about a local intervention is never a shared limit. */
internal fun sharedLimitCard(payload: NotificationPayload): SharedLimitCard? {
    if (payload.kind != "usage_limit_reached" && payload.kind != "usage_drain_warning") return null
    val key = payload.sharedLimitKey?.takeIf { it.matches(Regex("[A-Za-z0-9_-]{43}")) } ?: return null
    val expiresAt = payload.expiresAt?.let(::notificationTime) ?: return null
    return SharedLimitCard("shared-limit|${payload.kind}|$key", expiresAt)
}
