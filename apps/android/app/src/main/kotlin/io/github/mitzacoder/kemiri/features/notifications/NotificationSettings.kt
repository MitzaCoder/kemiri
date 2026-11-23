package io.github.mitzacoder.kemiri.features.notifications

import io.github.mitzacoder.kemiri.protocol.NotificationPreferences
import io.github.mitzacoder.kemiri.protocol.NotificationMute
import io.github.mitzacoder.kemiri.protocol.NotificationProjectMute
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.transformLatest
import io.github.mitzacoder.kemiri.protocol.NotificationPreferencesQuietHours
import kotlinx.serialization.Serializable

/** Quiet hours in the device's own timezone; same shape as the protocol's. */
@Serializable
data class QuietHours(val start: String, val end: String, val timezone: String, val allowFailures: Boolean)

/**
 * What this device wants to be told about (client `DeviceNotificationSettings`), kept in [io.github.mitzacoder.kemiri.data.DeviceSettings]
 * and registered with every backend: kinds and quiet hours are shared, mutes belong to the backend whose project it is.
 */
@Serializable
data class NotificationSettings(
    /** The user turned push on for this device; until then nothing registers and no token is made. */
    val enabled: Boolean = false,
    /** Optional relay transport; upgrades and fresh installs keep direct FCM until explicit opt-in. */
    val relayEnabled: Boolean = false,
    /** Key loss requires an explicit transport choice; it must never automatically re-register direct FCM. */
    val relayRecoveryRequired: Boolean = false,
    val kinds: List<String> = DEFAULT_NOTIFICATION_KINDS,
    val defaultsVersion: Int = NOTIFICATION_DEFAULTS_VERSION,
    val quietHours: QuietHours? = null,
    /** Backend key -> muted project IDs: a project ID only means something to the backend that made it. */
    val mutedProjects: Map<String, List<String>> = emptyMap(),
    val timedProjectMutes: Map<String, Map<String, Long>> = emptyMap(),
    val backendMutes: Map<String, NotificationMute> = emptyMap(),
    /** The FCM registration token this app instance has, once Firebase gave one. */
    val fcmToken: String? = null,
) {
    /** Kinds brought up to this build's defaults, unknown ones dropped. */
    fun migrated(): NotificationSettings {
        val known = NOTIFICATION_KINDS.filter { it in kinds }
        if (defaultsVersion >= NOTIFICATION_DEFAULTS_VERSION && known == kinds) return this
        return copy(kinds = if (defaultsVersion >= NOTIFICATION_DEFAULTS_VERSION) known else migrateDefaultKinds(known, defaultsVersion), defaultsVersion = NOTIFICATION_DEFAULTS_VERSION)
    }

    /** What this device registers with one backend. The server also checks the absolute expiry at delivery time. */
    fun preferencesFor(backendKey: String, now: Long = System.currentTimeMillis()) = NotificationPreferences(
        kinds = kinds,
        mutedProjects = mutedProjects[backendKey].orEmpty(),
        quietHours = quietHours?.let { NotificationPreferencesQuietHours(start = it.start, end = it.end, timezone = it.timezone, allowFailures = it.allowFailures) },
        projectMutes = timedProjectMutes[backendKey]?.filterValues { now < it }?.takeIf { it.isNotEmpty() }
            ?.map { (projectId, until) -> NotificationProjectMute(projectId, until) },
        backendMute = backendMutes[backendKey]?.takeIf { activeUntil(it.until, now) },
    )

    fun isMuted(backendKey: String, projectId: String?, now: Long = System.currentTimeMillis()): Boolean =
        backendMutes[backendKey]?.let { activeUntil(it.until, now) } == true ||
            (projectId != null && isProjectMuted(backendKey, projectId, now))

    internal fun isProjectMuted(backendKey: String, projectId: String, now: Long): Boolean =
        projectId in mutedProjects[backendKey].orEmpty() || timedProjectMutes[backendKey]?.get(projectId)?.let { now < it } == true

    fun withMuted(backendKey: String, projectId: String, muted: Boolean): NotificationSettings =
        withMute(backendKey, projectId, if (muted) NotificationMute() else null)

    /** A null mute clears the target. A mute without an end uses the existing indefinite project preference. */
    fun withMute(backendKey: String, projectId: String?, mute: NotificationMute?): NotificationSettings {
        if (projectId == null) return copy(backendMutes = if (mute == null) backendMutes - backendKey else backendMutes + (backendKey to mute))
        val indefinite = mutedProjects[backendKey].orEmpty().filterNot { it == projectId }
            .let { if (mute != null && mute.until == null) it + projectId else it }
        val timed = timedProjectMutes[backendKey].orEmpty() - projectId
        val nextTimed = mute?.until?.let { timed + (projectId to it) } ?: timed
        return copy(
            mutedProjects = if (indefinite.isEmpty()) mutedProjects - backendKey else mutedProjects + (backendKey to indefinite),
            timedProjectMutes = if (nextTimed.isEmpty()) timedProjectMutes - backendKey else timedProjectMutes + (backendKey to nextTimed),
        )
    }

    internal fun activeMutes(now: Long): List<ActiveNotificationMute> =
        backendMutes.mapNotNull { (backend, mute) -> ActiveNotificationMute(backend, null, mute.until).takeIf { activeUntil(it.until, now) } } +
            mutedProjects.flatMap { (backend, projects) -> projects.map { ActiveNotificationMute(backend, it, null) } } +
            timedProjectMutes.flatMap { (backend, projects) ->
                projects.filterValues { now < it }.map { (project, until) -> ActiveNotificationMute(backend, project, until) }
            }
}

internal data class ActiveNotificationMute(val backendKey: String, val projectId: String?, val until: Long?)

internal enum class NotificationMuteDuration(val label: String, private val hours: Long?) {
    OneHour("1 hour", 1), EightHours("8 hours", 8), Indefinite("Until I turn it back on", null);

    fun startingAt(now: Long) = NotificationMute(hours?.let { now + it * 3_600_000L })
}

private fun activeUntil(until: Long?, now: Long) = until == null || now < until

/** One wake-up at each expiry, not polling or rewriting device settings. */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
internal fun Flow<NotificationSettings>.activeMuteChanges(clock: () -> Long = System::currentTimeMillis): Flow<List<ActiveNotificationMute>> =
    distinctUntilChanged().transformLatest { settings ->
        while (true) {
            val now = clock()
            val active = settings.activeMutes(now)
            emit(active)
            val expiresAt = active.mapNotNull { it.until }.minOrNull() ?: break
            delay((expiresAt - clock()).coerceAtLeast(1))
        }
    }.distinctUntilChanged()

private val TIME_OF_DAY = Regex("^([01][0-9]|2[0-3]):[0-5][0-9]$")

/** The stored window, or the one a toggle starts from (client `quietHoursDraft`). */
fun quietHoursDraft(settings: NotificationSettings, timezone: String): QuietHours =
    settings.quietHours ?: QuietHours(start = "22:00", end = "07:00", timezone = timezone, allowFailures = true)

/** Why a quiet-hours draft cannot be saved, or null when it can (web `quietHoursProblem`). */
fun quietHoursProblem(quietHours: QuietHours): String? = when {
    !TIME_OF_DAY.matches(quietHours.start) || !TIME_OF_DAY.matches(quietHours.end) -> "Use a time like 22:00."
    quietHours.start == quietHours.end -> "Start and end are the same, so nothing would be quiet."
    quietHours.timezone.isBlank() -> "This device has no timezone."
    else -> null
}

/** "22:00–07:00 (Europe/Bucharest)". */
fun quietHoursSummary(quietHours: QuietHours): String = "${quietHours.start}–${quietHours.end} (${quietHours.timezone})"

/** Whether quiet hours cover [minuteOfDay] (0..1439, device time) for [kind]; failures pass when allowed. */
fun quietHoursActive(quietHours: QuietHours?, minuteOfDay: Int, kind: String? = null): Boolean {
    if (quietHours == null || quietHours.start == quietHours.end) return false
    if (kind != null && quietHours.allowFailures && isNotificationFailure(kind)) return false
    val start = minutes(quietHours.start) ?: return false
    val end = minutes(quietHours.end) ?: return false
    return if (start < end) minuteOfDay in start until end else minuteOfDay >= start || minuteOfDay < end
}

private fun minutes(value: String): Int? = TIME_OF_DAY.matchEntire(value)?.let { value.substring(0, 2).toInt() * 60 + value.substring(3, 5).toInt() }
