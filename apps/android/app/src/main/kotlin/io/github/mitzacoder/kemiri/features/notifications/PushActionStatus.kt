package io.github.mitzacoder.kemiri.features.notifications

import android.app.NotificationManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import io.github.mitzacoder.kemiri.HarnessApplication
import io.github.mitzacoder.kemiri.data.DeviceStore
import kotlinx.coroutines.CancellationException

/** Separate status identity so later pushes can arrive without overwriting Undo or a refusal. */
internal suspend fun postPushActionStatus(app: HarnessApplication, action: PendingPushAction, result: PushActionResult?, retry: Boolean = false) {
    if (!canPostNotifications(app)) return
    val manager = app.getSystemService(NotificationManager::class.java) ?: return
    val settings = try { DeviceStore(app).load() }
        catch (error: CancellationException) { throw error }
        catch (_: Exception) { null }
    val visibleText = settings?.inAppAlerts?.showMessageText == true
    val preview = action.text?.replace(Regex("\\s+"), " ")?.let { text ->
        val count = text.codePointCount(0, text.length)
        if (count > 80) text.substring(0, text.offsetByCodePoints(0, 79)) + "…" else text
    }
    val name = resolveBackend(action.payload.backendKey, settings?.backends.orEmpty())?.name ?: action.payload.computerName ?: "this computer"
    val pending = result == null && action.phase == PushActionPhase.Waiting
    val (title, line) = when (result) {
        null -> when {
            action.kind == PushActionKind.MarkRead -> "Marking read" to if (pending) "In 5 seconds. Undo cancels it." else "Marking this reply read…"
            visibleText && preview != null -> "Sending “$preview”" to if (pending) "In 5 seconds. Undo cancels it." else "Sending to $name…"
            else -> "Sending a message" to if (pending) "In 5 seconds. Undo cancels it." else "Sending…"
        }
        PushActionResult.Stale -> "This question changed" to "Nothing was sent. Open to read the current question."
        PushActionResult.ReadInApp -> "Open this question" to "Nothing was sent. Review it in the app."
        PushActionResult.SignedOut -> "Not sent" to "This phone is not signed in to that computer. Open the app to sign in."
        PushActionResult.Offline -> "Not sent" to if (visibleText && preview != null) "“$preview” was not sent to $name." else "The action did not reach the computer."
        PushActionResult.Unconfirmed -> "Could not confirm" to "The computer did not confirm delivery. Open to check."
        PushActionResult.StorageUnavailable -> "Not sent" to "The phone could not save this action. Open the app to continue."
        PushActionResult.Rejected -> "Not sent" to "The computer refused the action. Open the app to check it."
        PushActionResult.Sent -> return
    }
    val channel = notificationAttention(action.payload.kind).channelId
    val icon = notificationIcon(action.payload.kind)
    val open = notificationTap(app, action.statusTag, action.payload)
    val public = NotificationCompat.Builder(app, channel).setSmallIcon(icon)
        .setContentTitle(hiddenNotificationTitle(action.payload)).build()
    val builder = NotificationCompat.Builder(app, channel).setSmallIcon(icon)
        .setContentTitle(title).setContentText(line).setStyle(NotificationCompat.BigTextStyle().bigText(line))
        .setPublicVersion(public).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setContentIntent(open).setAutoCancel(result != null && !retry)
        .setSilent(result == null).setOnlyAlertOnce(result == null)
        .setOngoing(result == null).setAllowSystemGeneratedContextualActions(false)
        .setDeleteIntent(pushActionIntent(app, action.id, "dismiss"))
    if (pending) builder
        .setWhen(System.currentTimeMillis() + (action.dueElapsedMs - SystemClock.elapsedRealtime()).coerceAtLeast(0))
        .setShowWhen(true).setUsesChronometer(true).setChronometerCountDown(true)
        .addAction(unlockedPushAction("Undo", pushActionIntent(app, action.id, "undo")))
    if (retry) builder.addAction(unlockedPushAction("Try again", pushActionIntent(app, action.id, "retry")))
    if (result != null) builder.addAction(unlockedPushAction("Open", open, opensApp = true))
    try { manager.notify(action.statusTag, 0, builder.build()) } catch (_: SecurityException) { }
}
