package io.github.mitzacoder.kemiri.features.notifications

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
import io.github.mitzacoder.kemiri.features.settings.*
import androidx.compose.ui.text.font.FontWeight
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.navigation.ProjectMute
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.theme.LocalJarvisColors
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
fun ReportScreenPresence(backendKey: String?, projectId: String?) {
    val center = LocalNotificationCenter.current ?: return
    SideEffect { center.setScreen(backendKey, projectId) }
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
    val deviceSettings by repository.settings.collectAsStateWithLifecycle()
    val settings = deviceSettings.notifications
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

        SettingsGroup(title = "Muted projects", description = "A muted project sends this device nothing. Mute one with the bell in its chat header.") {
            val entries = settings.mutedEntries()
            if (entries.isEmpty()) GroupNote("No muted projects.")
            entries.forEach { (backendKey, projectId) ->
                val session = sessions.firstOrNull { it.config.key == backendKey }
                val projectName = session?.projects?.collectAsStateWithLifecycle()?.value?.firstOrNull { it.id == projectId }?.name
                GroupRow {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(projectName ?: projectId, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text(session?.config?.name ?: "A removed computer", style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)
                        }
                        TextButton(onClick = { update { it.withMuted(backendKey, projectId, false) } }, modifier = Modifier.heightIn(min = 44.dp)) { Text("Unmute") }
                    }
                }
            }
        }
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
