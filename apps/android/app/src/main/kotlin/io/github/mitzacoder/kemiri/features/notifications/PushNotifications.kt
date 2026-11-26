package io.github.mitzacoder.kemiri.features.notifications

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.service.notification.StatusBarNotification
import androidx.annotation.ChecksSdkIntAtLeast
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.github.mitzacoder.kemiri.HarnessApplication
import io.github.mitzacoder.kemiri.MainActivity
import io.github.mitzacoder.kemiri.R
import io.github.mitzacoder.kemiri.data.DeviceStore
import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.protocol.MAIN_THREAD_ID
import io.github.mitzacoder.kemiri.protocol.NotificationPayload
import java.time.Duration
import java.time.Instant

/** The intent a notification tap sends to [MainActivity], with the payload it should open. */
const val ACTION_OPEN_NOTIFICATION = io.github.mitzacoder.kemiri.BuildConfig.NOTIFICATION_INTENT_PREFIX + ".OPEN_NOTIFICATION"
const val EXTRA_NOTIFICATION_PAYLOAD = io.github.mitzacoder.kemiri.BuildConfig.NOTIFICATION_INTENT_PREFIX + ".NOTIFICATION_PAYLOAD"

private const val EXTRA_PUSH_IDENTITY = "kemiri.pushIdentity"
private const val EXTRA_PUSH_HAS_DETAILS = "kemiri.pushHasDetails"
private val pushCardsLock = Any()
private val finishedWorkLifetime = Duration.ofDays(1)

/** Android 13 asks for POST_NOTIFICATIONS; before it, only the app's notification switch in system settings counts. */
@get:ChecksSdkIntAtLeast(api = Build.VERSION_CODES.TIRAMISU)
val needsNotificationPermission get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU

fun canPostNotifications(context: Context): Boolean =
    (!needsNotificationPermission || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
        NotificationManagerCompat.from(context).areNotificationsEnabled()

internal fun notificationTime(at: String): Instant? = runCatching { Instant.parse(at) }.getOrNull()

internal fun finishedWorkTimeout(payload: NotificationPayload, now: Instant): Long? =
    finishedWorkLifetime.takeIf { notificationAttention(payload.kind) == NotificationAttention.FinishedWork }
        ?.let { lifetime -> Duration.between(now, (notificationTime(payload.at) ?: now).plus(lifetime)).toMillis() }

/** A task view is not a chat read. Neither one is enough to mark an individual question seen. */
internal fun AppPresence.handlesPush(payload: NotificationPayload): Boolean {
    if (!visible || backendKey != payload.backendKey || projectId != payload.projectId || projectId == null) return false
    return when (payload.kind) {
        "task_review", "task_steps" -> taskId != null && taskId == payload.taskId
        "reply", "work_finished", "thread_finished" -> coordinatorId == (payload.coordinatorId ?: payload.threadId ?: MAIN_THREAD_ID)
        else -> false
    }
}

private fun notificationTap(context: Context, identity: String, payload: NotificationPayload): PendingIntent {
    val open = Intent(context, MainActivity::class.java)
        .setAction(ACTION_OPEN_NOTIFICATION)
        // Extras do not identify PendingIntents. Two computers may use the same tag for different cards.
        .setData(Uri.Builder().scheme("kemiri-notification").appendPath(identity).build())
        .putExtra(EXTRA_NOTIFICATION_PAYLOAD, wireJson.encodeToString(NotificationPayload.serializer(), payload.copy(title = hiddenNotificationTitle(payload.kind), body = "")))
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
}

private fun publicNotification(context: Context, channel: String, icon: Int, title: String, time: Long) =
    NotificationCompat.Builder(context, channel).setSmallIcon(icon).setContentTitle(title)
        .setWhen(time).setShowWhen(true).build()

/** Direct FCM, relay and the debug receiver share this presentation. Reading preferences does not open sockets. */
suspend fun showPushNotification(context: Context, payload: NotificationPayload): Boolean {
    if (!canPostNotifications(context)) return false
    val manager = context.getSystemService(NotificationManager::class.java) ?: return false
    val attention = notificationAttention(payload.kind)
    val channel = attention.channelId
    if (manager.getNotificationChannel(channel)?.importance == NotificationManager.IMPORTANCE_NONE) return false
    val app = context.applicationContext as? HarnessApplication
    val center = app?.notificationsIfStarted
    val silent = center?.silentPush(payload) == true
    val stored = DeviceStore(context).load()
    val backendName = resolveBackend(payload.backendKey, stored.backends)?.name
    val projectName = center?.notificationProjectName(payload) ?: legacyNotificationProjectName(payload)
    val showDetails = stored.inAppAlerts.showMessageText
    val text = pushNotificationText(payload, projectName, backendName, showDetails)
    val now = Instant.now()
    val time = (notificationTime(payload.at) ?: now).toEpochMilli()
    val timeout = finishedWorkTimeout(payload, now)
    if (timeout != null && timeout <= 0) return false
    val cardTag = "${payload.backendKey}|${payload.tag}"
    val projectGroup = payload.projectId?.let { "project|${payload.backendKey}|$it" }
    val icon = notificationIcon(payload.kind)
    val notification = NotificationCompat.Builder(context, channel)
        .setSmallIcon(icon)
        .setContentTitle(text.title)
        .setContentText(text.body)
        .setSubText(text.context)
        .setStyle(NotificationCompat.BigTextStyle().bigText(text.body))
        .apply {
            if (projectGroup != null) setGroup(projectGroup).setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            if (timeout != null) setTimeoutAfter(timeout)
            if (showDetails) notificationBadge(context, payload.kind)?.let { setLargeIcon(it) }
            extras.putString(EXTRA_PUSH_IDENTITY, wireJson.encodeToString(NotificationPayload.serializer(), payload.copy(title = "", body = "")))
            extras.putBoolean(EXTRA_PUSH_HAS_DETAILS, showDetails)
        }
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setPublicVersion(publicNotification(context, channel, icon, hiddenNotificationTitle(payload.kind), time))
        .setContentIntent(notificationTap(context, cardTag, payload))
        .setAutoCancel(true)
        .setSilent(silent || attention == NotificationAttention.QuietUpdates)
        .setAllowSystemGeneratedContextualActions(false)
        .setWhen(time)
        .setShowWhen(true)
        .setCategory(if (attention == NotificationAttention.Problems) NotificationCompat.CATEGORY_ERROR else NotificationCompat.CATEGORY_MESSAGE)
        .build()
    return synchronized(pushCardsLock) {
        if (center?.presence?.value?.handlesPush(payload) == true) return@synchronized false
        try {
            manager.notify(cardTag, 0, notification)
            if (projectGroup != null) {
                val title = projectName?.takeIf { showDetails } ?: "Project updates"
                val projectTap = payload.copy(kind = "work_finished", threadId = null, workerId = null, scheduleId = null,
                    taskId = null, coordinatorId = null, entryId = null, answerId = null, artifactId = null)
                val summary = NotificationCompat.Builder(context, channel)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setSubText(title)
                    .setContentTitle(title)
                    .setContentIntent(notificationTap(context, projectGroup, projectTap))
                    .setGroup(projectGroup).setGroupSummary(true).setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                    .setSilent(true).setOnlyAlertOnce(true)
                    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                    .setPublicVersion(publicNotification(context, channel, R.drawable.ic_notification, "Project updates", time))
                    .setWhen(time).setShowWhen(true).build()
                manager.notify(projectGroup, 0, summary)
            }
            true
        } catch (_: SecurityException) {
            false
        }
    }
}

/** Recover card identities from Android, including after a process restart. Prune summaries emptied by the app. */
internal fun cancelPushCards(context: Context?, matches: (NotificationPayload, Boolean) -> Boolean) {
    val manager = context?.getSystemService(NotificationManager::class.java) ?: return
    synchronized(pushCardsLock) {
        val cards = manager.activeNotifications
        val removed = cards.filter { card ->
            val extras = card.notification.extras
            val identity = extras.getString(EXTRA_PUSH_IDENTITY)?.let { raw ->
                runCatching { wireJson.decodeFromString(NotificationPayload.serializer(), raw) }.getOrNull()
            }
            identity != null && matches(identity, extras.getBoolean(EXTRA_PUSH_HAS_DETAILS))
        }.toSet()
        removed.forEach { manager.cancel(it.tag, it.id) }
        val emptiedGroups = removed.mapNotNull { it.notification.group }.toSet() -
            cards.filter { it !in removed && !it.isGroupSummary() }.mapNotNull { it.notification.group }.toSet()
        cards.filter { it.isGroupSummary() && it.notification.group in emptiedGroups }.forEach { manager.cancel(it.tag, it.id) }
    }
}

private fun StatusBarNotification.isGroupSummary() = (notification.flags and Notification.FLAG_GROUP_SUMMARY) != 0
