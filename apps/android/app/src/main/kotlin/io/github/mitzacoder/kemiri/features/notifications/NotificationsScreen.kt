package io.github.mitzacoder.kemiri.features.notifications

import io.github.mitzacoder.kemiri.data.collectSettings
import android.Manifest
import android.content.Intent
import android.provider.Settings
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import io.github.mitzacoder.kemiri.data.BackendConfig
import io.github.mitzacoder.kemiri.data.BackendSession
import io.github.mitzacoder.kemiri.data.HarnessRepository
import io.github.mitzacoder.kemiri.data.localizedTimeFormatter
import io.github.mitzacoder.kemiri.protocol.NotificationMute
import io.github.mitzacoder.kemiri.features.settings.*
import androidx.compose.ui.text.font.FontWeight
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.navigation.ProjectMute
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.theme.LocalJarvisColors
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** The app's notification center, provided by [io.github.mitzacoder.kemiri.MainActivity]; null in previews and tests. */
val LocalNotificationCenter = staticCompositionLocalOf<NotificationCenter?> { null }

/**
 * The header's mute bell (`LocalProjectMute`, drawn by the project header): this device's mute for a project, shown
 * on a backend with `notifications`, as on the web.
 */
class CenterProjectMute(private val center: NotificationCenter) : ProjectMute {
    override fun muted(backend: BackendSession, projectId: String): StateFlow<Boolean>? =
        if (backend.client.state.value.supports("notifications")) center.mutedState(backend.config.key, projectId) else null

    override suspend fun toggle(backend: BackendSession, projectId: String) = center.toggleMute(backend.config.key, projectId)
}

/** Tell the notification center which project is on screen; the activity's start and stop say whether it is visible. */
@Composable
fun ReportScreenPresence(backendKey: String?, projectId: String?, coordinatorId: String?, taskId: String?) {
    val center = LocalNotificationCenter.current ?: return
    SideEffect { center.setScreen(backendKey, projectId, coordinatorId, taskId) }
}

/** Open a project link or a notification's target once the backends have loaded; [onUnknownBackend] gets the ID of a backend not here. */
@Composable
fun HandleAppLink(link: PendingAppLink?, loaded: Boolean, backends: List<BackendConfig>, navigate: (Destination) -> Unit, openSettingsLink: (Destination) -> Unit, onUnknownBackend: (String) -> Unit, onHandled: () -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(link, loaded) {
        if (link == null || !loaded) return@LaunchedEffect
        when (val resolved = link.resolve(backends)) {
            is AppLink.Open -> {
                val settings = resolved.destinations.lastOrNull()?.takeIf { it is Destination.Settings || it is Destination.ProjectSettings }
                if (settings != null) openSettingsLink(settings) else resolved.destinations.forEach(navigate)
            }
            is AppLink.UnknownBackend -> onUnknownBackend(resolved.backend)
            null -> Toast.makeText(context, "This link does not name a project.", Toast.LENGTH_LONG).show()
        }
        onHandled()
    }
}

/** General → Notifications (web `NotificationsSection.svelte`): this device's push, each backend's registration, kinds, quiet hours, mutes. */
@Composable
internal fun NotificationsSection(repository: HarnessRepository) {
    val center = LocalNotificationCenter.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val inAppAlerts by repository.collectSettings { it.inAppAlerts }
    val notificationPreferences by repository.collectSettings { it.notifications }
    val settings = notificationPreferences
    val sessions by repository.sessions.collectAsStateWithLifecycle()
    val states by (center?.states ?: remember { kotlinx.coroutines.flow.MutableStateFlow(emptyMap()) }).collectAsStateWithLifecycle()
    var message by rememberSaveable { mutableStateOf<String?>(null) }
    var permitted by remember { mutableStateOf(canPostNotifications(context)) }
    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(lifecycle, settings.enabled) { lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { permitted = canPostNotifications(context) } }
    fun update(transform: (NotificationSettings) -> NotificationSettings) { scope.launch { repository.setNotifications(transform) } }
    fun turnOn() {
        scope.launch { message = center?.enable() }
    }
    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permitted = canPostNotifications(context)
        if (granted) turnOn() else message = "Android blocks notifications for Kemiri. Allow them in the app's system settings, then turn them on again."
    }
    val unavailable = center?.pushUnavailableReason
    SettingsSectionPage(GeneralSection.Notifications) {
        InAppAlertSettingsGroup(inAppAlerts, { transform -> scope.launch { repository.setInAppAlerts(transform) } }) {
            val mutes = center?.activeMutes?.collectAsStateWithLifecycle()?.value ?: settings.activeMutes(System.currentTimeMillis())
            MutedNotificationsRow(sessions, mutes) { backendKey, projectId, mute ->
                update { it.withMute(backendKey, projectId, mute) }
            }
        }
        SettingsGroup(title = "This device", actions = { StatusChip(if (settings.enabled) "On" else "Off", if (settings.enabled) ChipTone.Ok else ChipTone.Muted) }) {
            SettingsRow(
                "Notifications on this device", hint = unavailable ?: "With the app open, a notification waits 15 seconds and is dropped if you use the app.", control = RowControl.Inline,
                learn = { Text("Push arrives through Firebase Cloud Messaging. Each computer decides what to send and when. This device chooses which kinds to show and which projects to mute.") },
                below = {
                    if (settings.enabled && !permitted) {
                        Text("Android blocks notifications for Kemiri, so nothing is shown.", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = {
                            context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                        }, modifier = Modifier.heightIn(min = 44.dp)) { Text("Open system settings") }
                    }
                    message?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted) }
                },
            ) {
                SettingsSwitch(settings.enabled, { on ->
                    message = null
                    if (!on) scope.launch { center?.disable() }
                    else if (permitted || !needsNotificationPermission) turnOn()
                    else askPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                }, "Notifications on this device", enabled = center != null && (unavailable == null || settings.enabled))
            }
        }

        SettingsGroup(title = "What to notify me about", description = kindsSummary(settings.kinds)) {
            val preset = notificationPreset(settings.kinds)
            SettingsRow("Alert preset") {
                Combobox(NOTIFICATION_PRESET_OPTIONS, preset.name, { pick ->
                    NotificationPreset.valueOf(pick).kinds?.let { kinds -> update { it.copy(kinds = kinds) } }
                }, "Notification preset", placeholder = NotificationPreset.Custom.label)
            }
            GroupRow {
                SettingsFold("Choose individual alerts") {
                    NOTIFICATION_ALERT_GROUPS.forEach { (label, kinds) ->
                        SettingsGroup(title = label) {
                            kinds.mapNotNull(::kindInfo).forEach { info ->
                                SettingsRow(info.label, hint = info.description, control = RowControl.Inline) {
                                    SettingsSwitch(info.kind in settings.kinds, { checked ->
                                        update { it.copy(kinds = withKind(it.kinds, info.kind, checked)) }
                                    }, info.label)
                                }
                            }
                        }
                    }
                    OutlinedButton(enabled = preset != NotificationPreset.Important, onClick = {
                        update { it.copy(kinds = DEFAULT_NOTIFICATION_KINDS) }
                    }) { Text("Reset to defaults") }
                }
            }
        }

        QuietHoursGroup(settings, ::update)

        SettingsFold("Delivery details") {
            io.github.mitzacoder.kemiri.features.notifications.relay.RelaySettingsSection(repository)

            SettingsGroup(title = "Computers", description = "Whether each computer can reach this device, and what its last push did.") {
                if (sessions.isEmpty()) GroupNote("No computers yet.")
                sessions.forEach { session -> key(session.config.key) {
                    val view = backendPushView(states[session.config.key], settings, center?.appFirebaseProject, unavailable)
                    var testing by remember { mutableStateOf(false) }
                    var result by remember { mutableStateOf<String?>(null) }
                    GroupRow {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(session.config.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            StatusChip(view.label, toneChip(view.tone))
                        }
                        Text(view.detail, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)
                        if (view.tone == BackendPushView.Tone.Ok || states[session.config.key]?.device != null) {
                            OutlinedButton(enabled = !testing && center != null, modifier = Modifier.padding(top = 8.dp).heightIn(min = 44.dp), onClick = {
                                scope.launch { testing = true; result = center?.sendTest(session.config.key); testing = false }
                            }) { Text(if (testing) "Sending…" else "Send test notification") }
                        }
                        result?.let { Text(it, Modifier.padding(top = 4.dp), style = MaterialTheme.typography.bodySmall) }
                    }
                } }
            }
        }
    }
}

@Composable
private fun InAppAlertSettingsGroup(
    settings: InAppAlertSettings, update: ((InAppAlertSettings) -> InAppAlertSettings) -> Unit,
    mutedRow: @Composable () -> Unit,
) {
    val until = settings.doNotDisturbUntil
    var now by remember(until) { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(until) {
        if (until != null && until != Long.MAX_VALUE && until > now) {
            kotlinx.coroutines.delay(until - now)
            now = System.currentTimeMillis()
        }
    }
    val pause = if (settings.disturbedAt(now)) settings.doNotDisturb else AlertPause.Off
    SettingsGroup(title = "In the app") {
        SettingsRow("Pop-ups", hint = "Show a small card when another project needs attention.") {
            Combobox(AlertPopUps.entries.map { ComboOption(it.name, it.label) }, settings.popUps.name,
                { pick -> update { it.copy(popUps = AlertPopUps.valueOf(pick)) } }, "Pop-ups")
        }
        SettingsRow("Sounds", hint = "Plays on the screen used last. Follows quiet hours below.") {
            Combobox(AlertSoundsSetting.entries.map { ComboOption(it.name, it.label) }, settings.sounds.name,
                { pick -> update { it.copy(sounds = AlertSoundsSetting.valueOf(pick)) } }, "Sounds")
        }
        SettingsRow("Show message text", hint = "Hide the details and answers on shared screens.", control = RowControl.Inline) {
            SettingsSwitch(settings.showMessageText, { show -> update { it.copy(showMessageText = show) } }, "Show message text")
        }
        SettingsRow("Do not disturb", hint = "Pause pop-ups and sounds without changing push.") {
            Combobox(AlertPause.entries.map { ComboOption(it.name, it.label) }, pause.name,
                { pick -> update { it.withPause(AlertPause.valueOf(pick), System.currentTimeMillis()) } },
                "Do not disturb")
        }
        mutedRow()
    }
}

private data class MuteTarget(val backendKey: String, val projectId: String?, val label: String) {
    val id get() = "$backendKey#${projectId.orEmpty()}"
}

@Composable
private fun MutedNotificationsRow(
    sessions: List<BackendSession>, mutes: List<ActiveNotificationMute>, save: (String, String?, NotificationMute?) -> Unit,
) {
    val targets = sessions.flatMap { session ->
        key(session.config.key) {
            val projects by session.projects.collectAsStateWithLifecycle()
            val backend = MuteTarget(session.config.key, null, session.config.name)
            listOf(backend) + projects.filter { it.state != "archived" }.map { project ->
                MuteTarget(backend.backendKey, project.id, "${project.name} · ${backend.label}")
            }
        }
    }
    SettingsRow("Muted", hint = "Pause pop-ups, sounds and push on this device.", control = RowControl.Full) {
        if (mutes.isEmpty()) Text("Nothing is muted.", color = Jarvis.colors.fgMuted, style = MaterialTheme.typography.bodySmall)
        for (mute in mutes) {
            val title = targets.firstOrNull { it.backendKey == mute.backendKey && it.projectId == mute.projectId }?.label
                ?: listOfNotNull(mute.projectId, sessions.firstOrNull { it.config.key == mute.backendKey }?.config?.name
                    ?: "A removed computer").joinToString(" · ")
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                    Text(muteEndLabel(mute.until), color = Jarvis.colors.fgMuted, style = MaterialTheme.typography.bodySmall)
                }
                TextButton(onClick = { save(mute.backendKey, mute.projectId, null) }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text("Unmute")
                }
            }
        }
        if (targets.isNotEmpty()) SettingsFold("Add a mute") {
            var selectedTarget by rememberSaveable { mutableStateOf("") }
            val target = targets.firstOrNull { it.id == selectedTarget }
            Combobox(targets.map { ComboOption(it.id, it.label) }, selectedTarget, { selectedTarget = it },
                "Mute target", placeholder = "Choose a project or computer")
            MuteDurationControl(enabled = target != null) { mute ->
                target?.let { save(it.backendKey, it.projectId, mute) }
            }
        }
    }
}

internal fun muteEndLabel(until: Long?): String = if (until == null) "Until I turn it back on"
    else "Until ${localizedTimeFormatter().format(Instant.ofEpochMilli(until).atZone(ZoneId.systemDefault()))}"

@Composable
internal fun MuteDurationControl(enabled: Boolean = true, onMute: (NotificationMute) -> Unit) {
    var duration by rememberSaveable { mutableStateOf(NotificationMuteDuration.OneHour) }
    Combobox(NotificationMuteDuration.entries.map { ComboOption(it.name, it.label) }, duration.name,
        { duration = NotificationMuteDuration.valueOf(it) }, "Mute duration", enabled = enabled)
    OutlinedButton(enabled = enabled, onClick = { onMute(duration.startingAt(System.currentTimeMillis())) },
        modifier = Modifier.heightIn(min = 48.dp)) { Text("Mute") }
}

private val NOTIFICATION_PRESET_OPTIONS = NotificationPreset.entries.filter { it.kinds != null }.map { ComboOption(it.name, it.label) }

@Composable
private fun QuietHoursGroup(settings: NotificationSettings, update: ((NotificationSettings) -> NotificationSettings) -> Unit) {
    val context = LocalContext.current
    val timezone = ZoneId.systemDefault().id
    val quiet = settings.quietHours
    var problem by rememberSaveable(quiet?.start, quiet?.end) { mutableStateOf<String?>(null) }
    fun pickTime(from: Boolean) {
        val current = quiet ?: return
        val time = LocalTime.parse(if (from) current.start else current.end)
        android.app.TimePickerDialog(context, { _, hour, minute ->
            val value = String.format(java.util.Locale.ROOT, "%02d:%02d", hour, minute)
            val proposed = if (from) current.copy(start = value, timezone = timezone) else current.copy(end = value, timezone = timezone)
            problem = quietHoursProblem(proposed)
            if (problem == null) update { latest ->
                latest.copy(quietHours = latest.quietHours?.let {
                    (if (from) it.copy(start = value, timezone = timezone) else it.copy(end = value, timezone = timezone))
                        .takeIf { changed -> quietHoursProblem(changed) == null } ?: it
                })
            }
        }, time.hour, time.minute, android.text.format.DateFormat.is24HourFormat(context)).show()
    }
    SettingsGroup(title = "Quiet hours", description = "Nothing is pushed between these times, in this device's time zone.", actions = { StatusChip(if (quiet != null) "On" else "Off", if (quiet != null) ChipTone.Ok else ChipTone.Muted) }) {
        SettingsRow("Quiet hours", hint = quiet?.let { quietHoursSummary(it) } ?: "Off", control = RowControl.Inline) {
            SettingsSwitch(quiet != null, { on -> update { it.copy(quietHours = if (on) quietHoursDraft(it, timezone) else null) } }, "Quiet hours")
        }
        if (quiet != null) {
            SettingsRow("From", control = RowControl.Inline) {
                OutlinedButton(onClick = { pickTime(true) }) { Text(io.github.mitzacoder.kemiri.data.displayWallTime(quiet.start)) }
            }
            SettingsRow("To", control = RowControl.Inline, below = {
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (quiet.timezone != timezone) Text("Set in ${quiet.timezone}; choosing a time uses $timezone.", style = MaterialTheme.typography.bodySmall)
            }) {
                OutlinedButton(onClick = { pickTime(false) }) { Text(io.github.mitzacoder.kemiri.data.displayWallTime(quiet.end)) }
            }
            SettingsRow("Still notify failures", hint = "Failed workers, schedules, deploys, compactions, maintenance, background jobs and low disk still come through.", control = RowControl.Inline) {
                SettingsSwitch(quiet.allowFailures, { on -> update { it.copy(quietHours = it.quietHours?.copy(allowFailures = on)) } }, "Still notify failures")
            }
        }
    }
}

private fun toneChip(tone: BackendPushView.Tone): ChipTone = when (tone) {
    BackendPushView.Tone.Ok -> ChipTone.Ok
    BackendPushView.Tone.Warn -> ChipTone.Warn
    BackendPushView.Tone.Err -> ChipTone.Err
    BackendPushView.Tone.Muted -> ChipTone.Muted
}
