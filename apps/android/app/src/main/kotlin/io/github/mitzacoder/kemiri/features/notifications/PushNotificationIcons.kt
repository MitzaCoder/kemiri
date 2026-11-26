package io.github.mitzacoder.kemiri.features.notifications

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import androidx.core.content.ContextCompat
import io.github.mitzacoder.kemiri.R

internal fun notificationIcon(kind: String): Int = when (kind) {
    "board_question", "login_prompt" -> R.drawable.ic_push_question
    "task_review", "task_steps" -> R.drawable.ic_push_review
    "reply" -> R.drawable.ic_push_reply
    else -> when (notificationAttention(kind)) {
        NotificationAttention.Problems -> R.drawable.ic_push_problem
        NotificationAttention.SubscriptionLimits -> R.drawable.ic_push_limit
        NotificationAttention.FinishedWork -> R.drawable.ic_push_finished
        NotificationAttention.QuietUpdates -> R.drawable.ic_push_quiet
        else -> R.drawable.ic_notification
    }
}

/** Some shades replace the small icon with the app's icon. Use a right-hand badge on cards that need a closer look. */
internal fun notificationBadge(context: Context, kind: String, projectName: String?, projectId: String?): Bitmap? {
    val color = when (notificationIcon(kind)) {
        R.drawable.ic_push_question, R.drawable.ic_push_review -> Color.rgb(91, 63, 155)
        R.drawable.ic_push_problem -> Color.rgb(166, 47, 55)
        R.drawable.ic_push_limit -> Color.rgb(72, 80, 132)
        else -> return null
    }
    val badge = if (projectName != null && projectId != null) notificationLetterIcon(projectName, projectId)
        else Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(badge)
    val size = if (projectName != null && projectId != null) {
        canvas.drawCircle(76f, 76f, 20f, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color })
        64 to 88
    } else {
        canvas.drawCircle(48f, 48f, 47f, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color })
        20 to 76
    }
    ContextCompat.getDrawable(context, notificationIcon(kind))?.apply {
        setBounds(size.first, size.first, size.second, size.second)
        draw(canvas)
    }
    return badge
}

/** A private, locally drawn mark. No network or remote image URL is needed to show a chat. */
internal fun notificationLetterIcon(label: String, identity: String): Bitmap {
    val bitmap = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.color = Color.HSVToColor(floatArrayOf(Math.floorMod(identity.hashCode(), 360).toFloat(), .58f, .57f))
    canvas.drawCircle(48f, 48f, 47f, paint)
    val initial = label.trim().takeIf { it.isNotEmpty() }?.let { String(Character.toChars(it.codePointAt(0))).uppercase() } ?: "•"
    paint.color = Color.WHITE
    paint.textSize = 48f
    paint.typeface = android.graphics.Typeface.DEFAULT_BOLD
    paint.textAlign = Paint.Align.CENTER
    canvas.drawText(initial, 48f, 48f - (paint.ascent() + paint.descent()) / 2, paint)
    return bitmap
}
