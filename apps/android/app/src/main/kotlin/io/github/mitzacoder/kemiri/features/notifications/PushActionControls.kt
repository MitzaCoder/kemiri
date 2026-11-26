package io.github.mitzacoder.kemiri.features.notifications

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.protocol.NotificationPayload
import java.util.UUID

private const val EXTRA_ACTION_SOURCE = "kemiri.actionSource"
private const val EXTRA_ACTION_TOKEN = "kemiri.actionToken"
private const val REPLY_TEXT = "kemiri.replyText"
internal const val PUSH_ACTION_SCHEME = "kemiri-push-action"
internal const val MAX_SHADE_REPLY_LENGTH = 12_000

internal data class PushQuestionActions(val directChoices: List<String>, val replyChoices: List<String>)

/** Reserve a slot for Later when offered. Remaining choices go in native reply chips. */
internal fun pushQuestionActions(payload: NotificationPayload): PushQuestionActions? {
    val question = payload.question ?: return null
    if (payload.kind != "board_question" || payload.projectId == null || question.id.isBlank() || question.revision < 1 ||
        question.approval == true || question.warning == true) return null
    val labels = question.choices.orEmpty().map { it.label }.takeIf { question.quickAnswerAllowed && it.size in 1..3 &&
        it.distinct().size == it.size && it.all { label -> label.isNotBlank() && label.codePointCount(0, label.length) <= 24 } }.orEmpty()
    val directSlots = if (payload.offersLater()) 1 else 2
    return PushQuestionActions(labels.take(directSlots), labels.drop(directSlots))
}

internal fun pushActionIntent(context: Context, token: String, action: String, argument: String = "", mutable: Boolean = false): PendingIntent {
    // Only RemoteInput needs a mutable Intent. Its component and data (the immutable route) are already filled in.
    val intent = Intent(context, PushActionReceiver::class.java).setAction("${context.packageName}.PUSH_ACTION")
        .setData(Uri.Builder().scheme(PUSH_ACTION_SCHEME).authority("notification").appendPath(token).appendPath(action).appendPath(argument).build())
    return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_CANCEL_CURRENT or
        if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE)
}

internal fun unlockedPushAction(title: String, intent: PendingIntent, semantic: Int = NotificationCompat.Action.SEMANTIC_ACTION_NONE,
    input: RemoteInput? = null, opensApp: Boolean = false): NotificationCompat.Action = NotificationCompat.Action.Builder(0, title, intent)
    .setAuthenticationRequired(true).setAllowGeneratedReplies(false).setSemanticAction(semantic)
    .setShowsUserInterface(opensApp).apply { if (input != null) addRemoteInput(input) }.build()

internal fun NotificationCompat.Builder.addPushActions(context: Context, payload: NotificationPayload, tap: PendingIntent) {
    val question = pushQuestionActions(payload)
    val reply = payload.kind == "reply" && payload.projectId != null
    val later = payload.offersLater()
    if (question == null && !reply && !later) {
        if (payload.kind == "board_question") addAction(unlockedPushAction("Open", tap, opensApp = true))
        return
    }
    val token = UUID.randomUUID().toString()
    extras.putString(EXTRA_ACTION_TOKEN, token)
    extras.putString(EXTRA_ACTION_SOURCE, wireJson.encodeToString(NotificationPayload.serializer(), payload))
    question?.directChoices?.forEachIndexed { index, label ->
        addAction(unlockedPushAction(label, pushActionIntent(context, token, "choice", index.toString())))
    }
    if (reply || question != null) {
        val input = RemoteInput.Builder(REPLY_TEXT).setLabel(if (reply) "Write a reply" else "Write an answer")
            .apply { if (!question?.replyChoices.isNullOrEmpty()) setChoices(question.replyChoices.toTypedArray()) }.build()
        addAction(unlockedPushAction("Reply", pushActionIntent(context, token, "reply", mutable = true), NotificationCompat.Action.SEMANTIC_ACTION_REPLY, input))
    }
    if (later) addAction(unlockedPushAction("Later", pushActionIntent(context, token, "later")))
    if (reply) addAction(unlockedPushAction("Mark read", pushActionIntent(context, token, "read"), NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ))
    else if (question?.directChoices.isNullOrEmpty()) addAction(unlockedPushAction("Open", tap, opensApp = true))
}

internal fun pushRemoteText(intent: Intent): String? = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(REPLY_TEXT)
    ?.toString()?.trim()?.takeIf { it.isNotEmpty() && it.length <= MAX_SHADE_REPLY_LENGTH }

internal data class PushActionSource(val tag: String, val payload: NotificationPayload)

/** The callback carries no backend, revision or choices. Read them from the exact still-visible card that owns it. */
internal fun findPushActionSource(manager: NotificationManager, token: String): PushActionSource? = manager.activeNotifications
    .firstOrNull { it.notification.extras.getString(EXTRA_ACTION_TOKEN) == token }?.let { card ->
        val raw = card.notification.extras.getString(EXTRA_ACTION_SOURCE)
        parseNotificationPayload(raw)?.let { PushActionSource(card.tag, it) }
    }
