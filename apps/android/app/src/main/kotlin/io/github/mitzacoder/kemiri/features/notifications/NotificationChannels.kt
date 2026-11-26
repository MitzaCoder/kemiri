package io.github.mitzacoder.kemiri.features.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context

/** Create the six channels on first launch or upgrade. Never recreate a legacy channel after migration. */
fun ensureNotificationChannels(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val migration = context.getSharedPreferences("notification-channels", Context.MODE_PRIVATE)
    if (migration.getBoolean("attention-channels-v1", false)) return
    val previous = manager.notificationChannels.associateBy { it.id }
    val channels = NotificationAttention.entries.map { attention ->
        val legacy = attention.legacyKinds.mapNotNull { previous["kind-$it"] }
        val importance = unanimousChannelChoice(legacy.map { channel -> channel.importance.takeIf { channel.hasUserSetImportance() } })
        val defaultImportance = when (attention) {
            NotificationAttention.NeedsYou, NotificationAttention.Problems -> NotificationManager.IMPORTANCE_HIGH
            NotificationAttention.QuietUpdates -> NotificationManager.IMPORTANCE_LOW
            else -> NotificationManager.IMPORTANCE_DEFAULT
        }
        NotificationChannel(attention.channelId, attention.label, importance ?: defaultImportance).apply {
            // A null sound is a choice too. Do not copy one kind's custom setting onto unmodified peers.
            if (legacy.isNotEmpty() && legacy.all { it.hasUserSetSound() } &&
                legacy.map { it.sound to it.audioAttributes }.distinct().size == 1) {
                setSound(legacy.first().sound, legacy.first().audioAttributes)
            }
        }
    }
    manager.createNotificationChannels(channels)
    NotificationAttention.entries.flatMap { it.legacyKinds }.forEach { manager.deleteNotificationChannel("kind-$it") }
    if (manager.getNotificationChannelGroup("events")?.channels?.isEmpty() == true) manager.deleteNotificationChannelGroup("events")
    migration.edit().putBoolean("attention-channels-v1", true).apply()
}

/** Carry a setting across only when all existing source channels explicitly chose the same value. */
internal fun <T : Any> unanimousChannelChoice(choices: List<T?>): T? = choices.distinct().singleOrNull()
