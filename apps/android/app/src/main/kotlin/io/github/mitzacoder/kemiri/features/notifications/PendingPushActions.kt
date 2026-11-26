package io.github.mitzacoder.kemiri.features.notifications

import android.app.KeyguardManager
import android.app.NotificationManager
import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.PersistableBundle
import android.os.SystemClock
import android.provider.Settings
import io.github.mitzacoder.kemiri.HarnessApplication
import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.protocol.NotificationPayload
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable

internal const val PUSH_UNDO_MS = 5_000L
// If the OS defers a job for minutes or the phone reboots, do not send a forgotten action later.
private const val ACTION_MAX_DELAY_MS = 120_000L
internal const val PUSH_JOB_ACTION_ID = "actionId"

@Serializable internal enum class PushActionKind { Answer, Reply, MarkRead, Later }
@Serializable internal enum class PushActionPhase { Waiting, Sending, Failed }
@Serializable internal data class PushActionBinding(val backendId: String, val sessionId: String)

@Serializable
internal data class PendingPushAction(
    val id: String,
    val notificationTag: String,
    val payload: NotificationPayload,
    val kind: PushActionKind,
    val text: String? = null,
    val binding: PushActionBinding? = null,
    val jobId: Int,
    val dueElapsedMs: Long,
    val bootCount: Int,
    val phase: PushActionPhase = PushActionPhase.Waiting,
    val failure: PushActionResult? = null,
) {
    val statusTag get() = "push-action|$id"
    fun canUndo(now: Long, boot: Int) = phase == PushActionPhase.Waiting && bootCount == boot && now < dueElapsedMs
    fun due(now: Long) = phase == PushActionPhase.Waiting && now >= dueElapsedMs
    fun expired(now: Long, boot: Int) = bootCount != boot || now - dueElapsedMs > ACTION_MAX_DELAY_MS
}

/** Device-private, credential-protected storage. The scheduler carries only a random action ID, not the answer. */
private class PushActionStore(context: Context) {
    private val preferences = context.getSharedPreferences("pending-notification-actions", Context.MODE_PRIVATE)

    fun all(): List<PendingPushAction> = preferences.all.keys.mapNotNull(::get)
    fun get(id: String): PendingPushAction? = preferences.getString(id, null)?.let {
        runCatching { wireJson.decodeFromString(PendingPushAction.serializer(), it) }.getOrNull()
    }

    fun save(action: PendingPushAction): Boolean = preferences.edit()
        .putString(action.id, wireJson.encodeToString(PendingPushAction.serializer(), action)).commit()

    fun remove(id: String): Boolean = preferences.edit().remove(id).commit()
}

/** The durable phase is the claim: the live timer and JobScheduler cannot both deliver the same action. */
internal class PendingPushActions(private val app: HarnessApplication) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Mutex()
    private val store = PushActionStore(app)
    private val notifications = app.getSystemService(NotificationManager::class.java)
    private val jobs = app.getSystemService(JobScheduler::class.java)
    private val bootCount: Int get() = Settings.Global.getInt(app.contentResolver, Settings.Global.BOOT_COUNT, -1)
    private val elapsed: Long get() = SystemClock.elapsedRealtime()
    private val unlocked: Boolean get() = pushActionsUnlocked(app)
    private val initialized = scope.async(start = CoroutineStart.LAZY) { recover() }

    fun startRecovery() { initialized.start() }

    suspend fun refreshStatusPrivacy() {
        initialized.await()
        lock.withLock { store.all().forEach { postPushActionStatus(app, it, it.failure, retry = it.failure != null) } }
    }

    suspend fun receive(intent: Intent) {
        val uri = intent.data?.takeIf { it.scheme == PUSH_ACTION_SCHEME && it.authority == "notification" } ?: return
        val parts = uri.pathSegments
        val token = parts.getOrNull(0) ?: return
        val operation = parts.getOrNull(1) ?: return
        initialized.await()
        if (operation != "dismiss" && !unlocked) return
        when (operation) {
            "undo" -> undo(token, restore = true)
            "dismiss" -> undo(token, restore = false)
            "retry" -> retry(token)
            "choice", "reply", "read", "later" -> stage(token, operation, parts.getOrNull(2)?.toIntOrNull(), pushRemoteText(intent))
        }
    }

    private suspend fun stage(token: String, operation: String, choice: Int?, freeText: String?) = lock.withLock {
        if (!unlocked || notifications == null || !canPostNotifications(app)) return@withLock
        val source = findPushActionSource(notifications, token) ?: return@withLock
        val payload = source.payload
        val question = pushQuestionActions(payload)
        val kind = when {
            operation == "choice" && question != null -> PushActionKind.Answer
            operation == "reply" && question != null -> PushActionKind.Answer
            operation == "reply" && payload.kind == "reply" -> PushActionKind.Reply
            operation == "read" && payload.kind == "reply" -> PushActionKind.MarkRead
            operation == "later" && payload.offersLater() -> PushActionKind.Later
            else -> return@withLock
        }
        val text = when (operation) {
            "choice" -> choice?.let { question?.directChoices?.getOrNull(it) } ?: return@withLock
            "reply" -> freeText ?: return@withLock
            else -> null
        }
        // Ignore repeated taps and old RemoteInput PendingIntents once this exact card has a pending mutation.
        val active = store.all()
        if (active.any { it.notificationTag == source.tag && it.phase != PushActionPhase.Failed }) return@withLock
        val binding = try { app.notificationActionBinding(payload.backendKey) }
            catch (error: CancellationException) { throw error }
            catch (_: Exception) { null }
        val id = UUID.randomUUID().toString()
        var jobId = (id.hashCode() and 0x3fffffff) + 1
        while (active.any { it.jobId == jobId }) jobId++
        val action = PendingPushAction(id, source.tag, payload, kind, text, binding, jobId, elapsed + PUSH_UNDO_MS, bootCount)
        if (!store.save(action)) { postPushActionStatus(app, action, PushActionResult.StorageUnavailable); return@withLock }
        if (!schedule(action)) {
            store.remove(id)
            postPushActionStatus(app, action, PushActionResult.Offline, retry = false)
            return@withLock
        }
        if (kind == PushActionKind.Later && !cancelPushActionCard(app, token, source)) {
            store.remove(id)
            jobs?.cancel(jobId)
            return@withLock
        }
        postPushActionStatus(app, action, result = null)
        if (kind != PushActionKind.Later) notifications.cancel(source.tag, 0)
        startTimer(action)
    }

    private fun schedule(action: PendingPushAction): Boolean {
        val remaining = (action.dueElapsedMs - elapsed).coerceAtLeast(0)
        val job = JobInfo.Builder(action.jobId, ComponentName(app, PushActionJobService::class.java))
            .setMinimumLatency(remaining).setOverrideDeadline(remaining + 1_000)
            .setExtras(PersistableBundle().apply { putString(PUSH_JOB_ACTION_ID, action.id) }).build()
        return runCatching { jobs?.schedule(job) == JobScheduler.RESULT_SUCCESS }.getOrDefault(false)
    }

    private fun startTimer(action: PendingPushAction) {
        scope.launch { delay((action.dueElapsedMs - elapsed).coerceAtLeast(0)); run(action.id) }
    }

    private suspend fun recover() = lock.withLock {
        for (action in store.all()) when {
            action.phase == PushActionPhase.Sending -> finish(action, PushActionResult.Unconfirmed)
            action.phase == PushActionPhase.Waiting -> {
                if (action.expired(elapsed, bootCount) || (jobs?.getPendingJob(action.jobId) == null && !schedule(action))) finish(action, PushActionResult.Offline)
                else startTimer(action)
            }
        }
    }

    private suspend fun retry(id: String) = lock.withLock {
        val prior = store.get(id)?.takeIf { it.phase == PushActionPhase.Failed } ?: return@withLock
        if (!unlocked || !canPostNotifications(app)) return@withLock
        if (store.all().any { it.id != id && it.notificationTag == prior.notificationTag && it.phase != PushActionPhase.Failed }) return@withLock
        val waiting = prior.copy(dueElapsedMs = elapsed + PUSH_UNDO_MS, bootCount = bootCount, phase = PushActionPhase.Waiting, failure = null)
        if (!store.save(waiting)) { postPushActionStatus(app, prior, PushActionResult.StorageUnavailable, retry = true); return@withLock }
        if (!schedule(waiting)) { finish(waiting, PushActionResult.Offline); return@withLock }
        postPushActionStatus(app, waiting, result = null)
        startTimer(waiting)
    }

    private suspend fun undo(id: String, restore: Boolean) {
        val action = lock.withLock {
            val existing = store.get(id) ?: return@withLock null
            if (restore && (!unlocked || !existing.canUndo(elapsed, bootCount))) return@withLock null
            if (!restore && existing.phase == PushActionPhase.Sending) return@withLock null
            if (!store.remove(id)) return@withLock null
            jobs?.cancel(existing.jobId)
            notifications?.cancel(existing.statusTag, 0)
            existing
        } ?: return
        if (restore) showPushNotification(app, action.payload, restoringTag = action.notificationTag)
    }

    suspend fun run(id: String) {
        initialized.await()
        val action = lock.withLock {
            val waiting = store.get(id)?.takeIf { it.due(elapsed) } ?: return@withLock null
            if (waiting.expired(elapsed, bootCount) || !unlocked) {
                finish(waiting, PushActionResult.Offline)
                return@withLock null
            }
            val sending = waiting.copy(phase = PushActionPhase.Sending)
            if (!store.save(sending)) { finish(waiting, PushActionResult.StorageUnavailable); return@withLock null }
            postPushActionStatus(app, sending, result = null)
            sending
        } ?: return
        val result = try { deliverPushAction(app, action) } catch (error: CancellationException) {
            withContext(NonCancellable) { lock.withLock { finish(action, PushActionResult.Unconfirmed) } }
            throw error
        }
        withContext(NonCancellable) { lock.withLock { finish(action, result) } }
    }

    private suspend fun finish(action: PendingPushAction, result: PushActionResult) {
        val retry = when (result) {
            PushActionResult.Offline -> action.binding != null || action.kind == PushActionKind.MarkRead && action.payload.answerId == null
            // A reply ID and the answer revision survive retries. Never automatically retry a possibly committed action.
            PushActionResult.Unconfirmed -> action.binding != null && action.kind != PushActionKind.Later
            else -> false
        }
        val keepRetry = if (retry) store.save(action.copy(phase = PushActionPhase.Failed, failure = result)) else { store.remove(action.id); false }
        if (result == PushActionResult.Sent) notifications?.cancel(action.statusTag, 0)
        else postPushActionStatus(app, action, result, keepRetry)
    }
}

internal fun pushActionsUnlocked(context: Context): Boolean =
    context.getSystemService(KeyguardManager::class.java)?.let { !it.isKeyguardLocked && !it.isDeviceLocked } == true
