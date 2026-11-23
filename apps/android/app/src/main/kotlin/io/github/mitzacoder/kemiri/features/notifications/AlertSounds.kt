package io.github.mitzacoder.kemiri.features.notifications

import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.SoundPool
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import io.github.mitzacoder.kemiri.R
import java.util.concurrent.ConcurrentHashMap

/** The application owns one pool, so a backend or activity change cannot restart an already playing tone. */
internal class AlertSounds(context: Context) {
    private val audio = context.getSystemService(AudioManager::class.java)
    private val notifications = context.getSystemService(NotificationManager::class.java)
    @Suppress("DEPRECATION")
    private val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        context.getSystemService(VibratorManager::class.java)?.defaultVibrator
    } else context.getSystemService(Vibrator::class.java)
    private val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()
    private val pool = SoundPool.Builder().setMaxStreams(1).setAudioAttributes(attributes).build()
    private val loaded = ConcurrentHashMap.newKeySet<Int>()
    private val urgent: Int
    private val soft: Int

    init {
        pool.setOnLoadCompleteListener { _, sampleId, status -> if (status == 0) loaded.add(sampleId) }
        urgent = pool.load(context, R.raw.alert_urgent, 1)
        soft = pool.load(context, R.raw.alert_soft, 1)
    }

    fun play(tone: AlertTone): Boolean {
        // These chimes are ordinary notifications, not priority contacts, calls or alarms.
        if (notifications?.currentInterruptionFilter != NotificationManager.INTERRUPTION_FILTER_ALL) return false
        if (audio?.ringerMode != AudioManager.RINGER_MODE_NORMAL) {
            if (audio == null || tone != AlertTone.Urgent || vibrator?.hasVibrator() != true) return false
            @Suppress("DEPRECATION")
            vibrator.vibrate(VibrationEffect.createOneShot(70, VibrationEffect.DEFAULT_AMPLITUDE), attributes)
            return true
        }
        val sample = if (tone == AlertTone.Urgent) urgent else soft
        return sample in loaded && pool.play(sample, 1f, 1f, 1, 0, 1f) != 0
    }
}
