package io.github.mitzacoder.kemiri.features.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.BackendSession
import io.github.mitzacoder.kemiri.protocol.CoordinatorCompaction
import io.github.mitzacoder.kemiri.protocol.DEFAULT_COORDINATOR_COMPACTION

@Composable
internal fun CoordinatorCompactionGroup(backend: BackendSession, ready: Boolean) {
    val thresholds by backend.coordinatorCompaction.collectAsStateWithLifecycle()
    val saved = thresholds
    val defaults = DEFAULT_COORDINATOR_COMPACTION
    val saveState = rememberSaveState(backend.config.key)
    val focus = LocalFocusManager.current
    var background by remember(saved) { mutableStateOf(saved?.backgroundPercent?.toString().orEmpty()) }
    var blocking by remember(saved) { mutableStateOf(saved?.blockingPercent?.toString().orEmpty()) }
    val enabled = ready && saved != null && saveState.status != SaveStatus.Saving
    val changed = background != saved?.backgroundPercent?.toString() || blocking != saved?.blockingPercent?.toString()

    fun apply(next: CoordinatorCompaction) {
        focus.clearFocus()
        saveState.launch {
            backend.setCoordinatorCompaction(next)
            background = next.backgroundPercent.toString()
            blocking = next.blockingPercent.toString()
        }
    }

    SettingsGroup {
        SettingsFold("Conversation summaries") {
            GroupNote("For all coordinators on this computer. The percentages measure how full the model’s context window is.")
            if (saved == null) GroupNote("Summary settings are not loaded.")
            else {
                CompactionPercentRow("Start summarizing in the background at", "20–90%", background, enabled) { background = it }
                CompactionPercentRow("Pause and wait for the summary at", "30–95%, higher than the background point", blocking, enabled) { blocking = it }
                GroupRow {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = {
                            val backgroundPercent = background.toLongOrNull()
                            val blockingPercent = blocking.toLongOrNull()
                            if (backgroundPercent == null || backgroundPercent !in 20L..90L || blockingPercent == null ||
                                blockingPercent !in 30L..95L || blockingPercent <= backgroundPercent) {
                                saveState.fail("Use whole percentages: background 20–90, wait 30–95 and higher than background.")
                            } else apply(CoordinatorCompaction(backgroundPercent, blockingPercent))
                        }, enabled = enabled && changed, modifier = Modifier.heightIn(min = 48.dp)) { Text("Save") }
                        OutlinedButton(onClick = { apply(defaults) }, enabled = enabled && (saved != defaults || changed),
                            modifier = Modifier.heightIn(min = 48.dp)) { Text("Reset to defaults") }
                    }
                    SaveStatusLine(saveState, reserve = false)
                }
            }
        }
    }
}

@Composable
private fun CompactionPercentRow(label: String, hint: String, percent: String, enabled: Boolean, onChange: (String) -> Unit) {
    SettingsRow(label, hint = hint, control = RowControl.Auto) {
        OutlinedTextField(
            value = percent, onValueChange = onChange,
            modifier = Modifier.width(112.dp).semantics { contentDescription = label },
            enabled = enabled, singleLine = true, suffix = { Text("%") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )
    }
}
