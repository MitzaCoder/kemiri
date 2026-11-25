package io.github.mitzacoder.kemiri.data

import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/** Collect a screen's preference slice, not unrelated writes such as seen-reply updates. */
@Composable
internal fun <T> HarnessRepository.collectSettings(
    vararg keys: Any?, select: (DeviceSettings) -> T,
): State<T> {
    val (flow, initial) = remember(this, *keys) { settings.map(select).distinctUntilChanged() to select(settings.value) }
    return flow.collectAsStateWithLifecycle(initial)
}
