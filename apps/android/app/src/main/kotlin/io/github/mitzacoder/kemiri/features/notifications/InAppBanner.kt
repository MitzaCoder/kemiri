package io.github.mitzacoder.kemiri.features.notifications

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.HarnessRepository
import io.github.mitzacoder.kemiri.features.chat.markdownText
import io.github.mitzacoder.kemiri.protocol.NotificationPayload
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlin.math.abs
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal const val QUESTION_CHANGED = "This question changed"

internal fun InAppAlert.pushPayload() = with(alert) {
    NotificationPayload(kind, title, body, this@pushPayload.backendKey, projectId, workerId, scheduleId,
        coordinatorId, entryId, threadId, artifactId, taskId, tag, at, answerId = answerId)
}

/** Sits in the focused window, above screen content but outside the status bar and the composer. */
@Composable
internal fun InAppBannerHost(repository: HarnessRepository, onOpen: (InAppAlert) -> Unit, onNeedsYou: () -> Unit) {
    val center = LocalNotificationCenter.current ?: return
    val presence by center.presence.collectAsStateWithLifecycle()
    val banners by center.banners.collectAsStateWithLifecycle()
    val settings by repository.settings.collectAsStateWithLifecycle()
    val banner = banners.firstOrNull() ?: return
    var menuOpen by remember(banner.id, presence.visible) { mutableStateOf(false) }
    if (!presence.visible || (!LocalWindowInfo.current.isWindowFocused && !menuOpen) ||
        settings.inAppAlerts.disturbedAt(System.currentTimeMillis())) return
    val sessions by repository.sessions.collectAsStateWithLifecycle()
    val session = sessions.firstOrNull { it.config.key == banner.latest.backendKey }
    val projects = session?.projects?.collectAsStateWithLifecycle()?.value.orEmpty()
    val projectName = projects.firstOrNull { it.id == banner.latest.alert.projectId }?.name
        ?: banner.latest.alert.projectId ?: "Kemiri"
    val dismiss = { center.dismissBanner(banner.id) }
    val open = {
        dismiss()
        if (banner.kind == AlertBannerKind.Single) onOpen(banner.latest) else onNeedsYou()
    }
    BoxWithConstraints(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))) {
        // In landscape or with the keyboard open, let the card scroll rather than obscure the composer.
        val availableHeight = (maxHeight - WindowInsets.ime.asPaddingValues().calculateBottomPadding()).coerceAtLeast(0.dp)
        if (availableHeight < 120.dp) return@BoxWithConstraints
        LaunchedEffect(banner.id, banner.alerts) {
            withFrameNanos { }
            center.bannerShown(banner)
        }
        LaunchedEffect(banner.id, banner.durationMs, menuOpen) {
            if (menuOpen) return@LaunchedEffect
            try {
                withFrameNanos { }
                center.startBannerClock(banner.id)?.let { delay(it); dismiss() }
            } finally { center.stopBannerClock(banner.id) }
        }
        key(banner.id) {
            AlertBannerCard(banner, banners.size, projectName, session?.config?.name, settings.inAppAlerts.showMessageText,
                dismiss, open, onNeedsYou, { answer -> center.answerAlert(banner.latest, answer) },
                menuOpen = menuOpen, onMenuOpen = { menuOpen = it },
                onMute = { projectId -> center.muteFromBanner(banner.latest.backendKey, projectId) },
                onTurnOffSounds = center::turnOffAlertSounds,
                modifier =
                Modifier.align(Alignment.TopCenter).padding(horizontal = 8.dp, vertical = 4.dp)
                    .widthIn(max = 480.dp).fillMaxWidth().heightIn(max = (availableHeight - 56.dp).coerceAtMost(320.dp)),
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AlertBannerCard(
    banner: AlertBanner, count: Int, projectName: String, backendName: String?, showText: Boolean,
    dismiss: () -> Unit, open: () -> Unit, openNeedsYou: () -> Unit,
    answer: suspend (String) -> String?, menuOpen: Boolean, onMenuOpen: (Boolean) -> Unit,
    onMute: (String?) -> Unit, onTurnOffSounds: () -> Unit, modifier: Modifier,
) {
    val latest = banner.latest
    val urgent = banner.level == "Urgent"
    val colors = Jarvis.colors
    val accent = when (banner.level) {
        "Urgent" -> MaterialTheme.colorScheme.error
        "Important" -> colors.fg
        else -> colors.fgMuted
    }
    val shape = when (banner.level) { "Urgent" -> "▲"; "Important" -> "◆"; else -> "●" }
    val scope = rememberCoroutineScope()
    var marked by remember(latest.identity) { mutableStateOf<String?>(null) }
    var problem by remember(latest.identity) { mutableStateOf<String?>(null) }
    var submitting by remember(latest.identity) { mutableStateOf(false) }
    val choices = if (showText && banner.kind == AlertBannerKind.Single && problem != QUESTION_CHANGED) latest.inlineChoices() else emptyList()
    var drag by remember { mutableFloatStateOf(0f) }
    val dismissThreshold = 64.dp
    val dismissBanner by rememberUpdatedState(dismiss)
    val provenance = if (!showText) projectName else listOfNotNull(projectName, backendName).joinToString(" · ")
    val projectCount = banner.alerts.map { it.project }.distinct().size
    val title = when {
        !showText -> "New question"
        banner.kind == AlertBannerKind.Burst -> "$projectName: ${banner.alerts.size} new things"
        banner.kind == AlertBannerKind.CatchUp -> "While you were away: ${banner.alerts.size} things in $projectCount ${if (projectCount == 1) "project" else "projects"}"
        else -> latest.alert.title
    }
    val body = latest.alert.body.takeIf { showText && banner.kind == AlertBannerKind.Single }
        ?.let { if (latest.alert.kind == "board_question") markdownText(it) else it }
        ?.takeUnless { it.isBlank() || it == title }
    Surface(
        modifier = modifier.graphicsLayer { translationX = drag }
            .pointerInput(dismissThreshold) {
                detectHorizontalDragGestures(
                    onDragEnd = { if (abs(drag) >= dismissThreshold.toPx()) dismissBanner(); drag = 0f },
                    onDragCancel = { drag = 0f },
                ) { _, distance -> drag += distance }
            }
            .semantics { liveRegion = if (urgent) LiveRegionMode.Assertive else LiveRegionMode.Polite },
        color = colors.surface2, contentColor = colors.fg, shape = RoundedCornerShape(14.dp),
        shadowElevation = 8.dp, border = BorderStroke(1.dp, accent.copy(alpha = 0.48f)),
    ) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(start = 12.dp, end = 4.dp, bottom = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).heightIn(min = 48.dp).clickable(onClickLabel = "Open notification", onClick = open),
                    verticalArrangement = Arrangement.Center) {
                    if (showText) Text("$shape  ${banner.level}", color = accent, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
                    Text(provenance, color = colors.fgMuted, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (count > 1) TextButton(onClick = openNeedsYou, modifier = Modifier.heightIn(min = 48.dp)) { Text("1 of $count") }
                Box {
                    IconButton(onClick = { onMenuOpen(true) }, modifier = Modifier.size(48.dp)) {
                        LucideGlyph(Lucide.MoreHorizontal, size = 20.dp, contentDescription = "Notification actions")
                    }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { onMenuOpen(false) }) {
                        val projectId = latest.alert.projectId
                        if (projectId != null && projectCount == 1) {
                            DropdownMenuItem(text = { Text("Mute $projectName for 1 hour") },
                                onClick = { onMenuOpen(false); onMute(projectId) })
                        }
                        if (backendName != null && banner.alerts.all { it.backendKey == latest.backendKey }) {
                            DropdownMenuItem(text = { Text("Mute $backendName for 1 hour") },
                                onClick = { onMenuOpen(false); onMute(null) })
                        }
                        DropdownMenuItem(text = { Text("Turn off sounds") },
                            onClick = { onMenuOpen(false); onTurnOffSounds() })
                    }
                }
                IconButton(onClick = dismiss, modifier = Modifier.size(48.dp)) {
                    LucideGlyph(Lucide.X, size = 20.dp, contentDescription = "Dismiss notification")
                }
            }
            Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClickLabel = "Open notification", onClick = open).padding(end = 8.dp),
                verticalArrangement = Arrangement.Center) {
                Text(title, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleSmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
                body?.let { Text(it, color = colors.fgMuted, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis) }
            }
            if (showText) problem?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            if (choices.isNotEmpty() || banner.kind != AlertBannerKind.Single || (showText && problem == QUESTION_CHANGED)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 2.dp, end = 4.dp)) {
                    choices.forEach { choice ->
                        val selected = marked == choice.label
                        FilterChip(selected = selected, enabled = !submitting, modifier = Modifier.heightIn(min = 48.dp).widthIn(min = 48.dp),
                            onClick = {
                                if (!selected) { marked = choice.label; problem = null }
                                else {
                                    submitting = true
                                    scope.launch {
                                        problem = answer(choice.label)
                                        submitting = false
                                    }
                                }
                            }, label = { Text(if (selected && !submitting) "Send ${choice.label}" else choice.label, fontWeight = if (choice.recommended) FontWeight.SemiBold else FontWeight.Normal) })
                    }
                    TextButton(onClick = open, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(if (banner.kind == AlertBannerKind.Single) "Open" else "Open Needs you")
                    }
                }
            }
        }
    }
}
