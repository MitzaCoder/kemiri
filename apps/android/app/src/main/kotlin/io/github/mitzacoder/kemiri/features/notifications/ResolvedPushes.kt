package io.github.mitzacoder.kemiri.features.notifications

import android.content.Context
import io.github.mitzacoder.kemiri.protocol.NotificationPayload
import io.github.mitzacoder.kemiri.protocol.NotificationPayloadResolvedItem
import java.util.concurrent.TimeUnit

private val clearReceiptLifetime = TimeUnit.DAYS.toMillis(1)
private const val CLEAR_PREFERENCES = "quiet-push-clears"
internal const val RESOLVED_PUSH_FEATURE = "notification-resolved-push"

internal fun validResolvedTargets(payload: NotificationPayload): List<NotificationPayloadResolvedItem>? =
    payload.resolved?.takeIf { targets -> targets.size in 1..16 && targets.all { it.tag.isNotBlank() && notificationTime(it.at) != null } }

/** Exact match: an older revision's clear must never dismiss the replacement. */
internal fun matchesResolvedTarget(backendKey: String, target: NotificationPayloadResolvedItem, card: NotificationPayload): Boolean =
    (target.sharedLimitKey != null && target.sharedLimitKey == card.sharedLimitKey) ||
        (backendKey == card.backendKey && target.tag == card.tag && target.at == card.at && target.key == card.key)

private fun clearIdentity(backendKey: String, tag: String, at: String, key: String?): String =
    listOf(backendKey, tag, at, key.orEmpty()).joinToString("\u0000")

/** Keep an exact receipt so an original delayed by Play Services cannot reappear after its clear. */
internal fun saveResolvedTargets(context: Context, backendKey: String, targets: List<NotificationPayloadResolvedItem>, now: Long) {
    val receipts = context.getSharedPreferences(CLEAR_PREFERENCES, Context.MODE_PRIVATE)
    val edit = receipts.edit()
    receipts.all.forEach { (id, expiry) -> if (expiry is Long && expiry <= now) edit.remove(id) }
    for (target in targets) {
        edit.putLong(clearIdentity(backendKey, target.tag, target.at, target.key), now + clearReceiptLifetime)
        target.sharedLimitKey?.let { edit.putLong("shared:$it", now + clearReceiptLifetime) }
    }
    edit.apply()
}

internal fun pushWasResolved(context: Context, payload: NotificationPayload, now: Long): Boolean {
    val receipts = context.getSharedPreferences(CLEAR_PREFERENCES, Context.MODE_PRIVATE)
    return receipts.getLong(clearIdentity(payload.backendKey, payload.tag, payload.at, payload.key), 0) > now ||
        (payload.sharedLimitKey?.let { receipts.getLong("shared:$it", 0) > now } == true)
}
