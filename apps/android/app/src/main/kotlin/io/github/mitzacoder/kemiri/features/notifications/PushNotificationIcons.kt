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
internal fun notificationBadge(context: Context, kind: String): Bitmap? {
    val color = when (notificationIcon(kind)) {
        R.drawable.ic_push_question, R.drawable.ic_push_review -> Color.rgb(91, 63, 155)
        R.drawable.ic_push_problem -> Color.rgb(166, 47, 55)
        R.drawable.ic_push_limit -> Color.rgb(72, 80, 132)
        else -> return null
    }
    val badge = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(badge)
    canvas.drawCircle(48f, 48f, 47f, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color })
    ContextCompat.getDrawable(context, notificationIcon(kind))?.apply {
        setBounds(20, 20, 76, 76)
        draw(canvas)
    }
    return badge
}
