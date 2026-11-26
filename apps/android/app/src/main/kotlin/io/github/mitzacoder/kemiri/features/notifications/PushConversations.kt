package io.github.mitzacoder.kemiri.features.notifications

import android.app.Notification
import android.content.Context
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.LocusIdCompat
import androidx.core.graphics.drawable.IconCompat
import io.github.mitzacoder.kemiri.protocol.MAIN_THREAD_ID
import io.github.mitzacoder.kemiri.protocol.NotificationPayload
import java.security.MessageDigest
import java.util.Base64

private const val CHAT_SHORTCUT_PREFIX = "push-chat-"

internal data class PushConversation(val shortcutId: String, val name: String, val projectName: String?, val coordinatorId: String) {
    val label: String get() = if (projectName == null || projectName == name) name else "$name · $projectName"
}

internal fun pushConversation(payload: NotificationPayload, projectName: String?): PushConversation? {
    val projectId = payload.projectId ?: return null
    if (payload.kind != "reply" && (payload.kind != "board_question" || payload.question?.approval == true || payload.question?.warning == true ||
        (payload.question == null && payload.title.startsWith("Warning · ")))) return null
    // A background job is not a coordinator chat. When the push explicitly names a coordinator, use that chat.
    val coordinatorId = payload.coordinatorId ?: MAIN_THREAD_ID
    val name = (payload.coordinatorName ?: if (payload.coordinatorId != null && payload.kind == "reply") {
        payload.title.substringAfter(" · ", "").ifBlank { null }
    } else null) ?: "Main chat".takeIf { coordinatorId == MAIN_THREAD_ID } ?: "Coordinator"
    val digest = MessageDigest.getInstance("SHA-256").digest(listOf(payload.backendKey, projectId, coordinatorId).joinToString("\u0000").toByteArray())
    return PushConversation(CHAT_SHORTCUT_PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(digest), name, projectName, coordinatorId)
}

/** The same shortcut/person identifies a chat across notifications, title changes and process restarts. */
internal fun NotificationCompat.Builder.showConversation(
    context: Context, chat: PushConversation, payload: NotificationPayload, text: PushNotificationText, time: Long, previous: Notification?,
) {
    val icon = notificationLetterIcon(chat.name, chat.shortcutId)
    val coordinator = Person.Builder().setKey(chat.shortcutId).setName(chat.name).setIcon(IconCompat.createWithBitmap(icon)).build()
    val manager = context.getSystemService(ShortcutManager::class.java)
    val shortcutAvailable = runCatching {
        if (manager == null) return@runCatching false
        val existing = manager.dynamicShortcuts.firstOrNull { it.id == chat.shortcutId }
        if (existing?.shortLabel?.toString() != chat.label) {
            val route = payload.copy(kind = "reply", coordinatorId = chat.coordinatorId, threadId = chat.coordinatorId, entryId = null,
                taskId = null, answerId = null, question = null, workerId = null, scheduleId = null, artifactId = null)
            val shortcutIcon = Icon.createWithBitmap(icon)
            val shortcutPerson = android.app.Person.Builder().setKey(chat.shortcutId).setName(chat.name).setIcon(shortcutIcon).build()
            val shortcut = ShortcutInfo.Builder(context, chat.shortcutId)
                .setShortLabel(chat.label).setLongLived(true)
                .setIcon(shortcutIcon).setPerson(shortcutPerson)
                .setLocusId(android.content.LocusId(chat.shortcutId))
                .setIntent(notificationOpenIntent(context, chat.shortcutId, route))
                .build()
            // A launcher-excluded shortcut is not published and consequently cannot rank as a conversation.
            manager.pushDynamicShortcut(shortcut)
        }
        true
    }.onFailure { android.util.Log.w("KemiriPush", "Chat shortcut could not be published: ${it.javaClass.simpleName}") }.getOrDefault(false)
    if (shortcutAvailable) setShortcutId(chat.shortcutId).setLocusId(LocusIdCompat(chat.shortcutId))
    setLargeIcon(icon)
    val style = NotificationCompat.MessagingStyle(Person.Builder().setName("Me").build()).setGroupConversation(false)
    if (payload.kind == "reply" && previous != null) {
        NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(previous)?.messages.orEmpty().forEach(style::addMessage)
    }
    val message = if (payload.kind == "reply") text.body.ifBlank { "A reply is ready" } else buildString {
        append(text.title)
        if (text.body.isNotBlank()) append("\n\n").append(text.body)
        payload.question?.takeIf { it.quickAnswerAllowed }?.choices?.firstOrNull { it.recommended }?.let {
            append("\n\nSuggested: ").append(it.label)
        }
    }
    style.addMessage(message, time, coordinator)
    setStyle(style).setSubText(chat.projectName)
}

internal fun removePushConversationShortcuts(context: Context?) {
    val manager = context?.getSystemService(ShortcutManager::class.java) ?: return
    val ids = manager.getShortcuts(ShortcutManager.FLAG_MATCH_DYNAMIC or ShortcutManager.FLAG_MATCH_CACHED)
        .map { it.id }.distinct().filter { it.startsWith(CHAT_SHORTCUT_PREFIX) }
    if (ids.isNotEmpty()) manager.removeLongLivedShortcuts(ids)
}
