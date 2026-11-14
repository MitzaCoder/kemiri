package io.github.mitzacoder.kemiri.navigation

import kotlinx.coroutines.CancellationException

internal class NestedBackTarget(val depth: Int, val parentLabel: String? = null, val back: () -> Unit)

/** Native dialogs own their window; inside the app, drawer > deepest sub-view > navigation stack. */
internal fun resolveBackTarget(
    drawerBack: (() -> Unit)?,
    nested: List<NestedBackTarget>,
    stackBack: (() -> Unit)?,
): (() -> Unit)? = drawerBack ?: nested.maxByOrNull { it.depth }?.back ?: stackBack

/** Progress is deliberately read-only. Cancel leaves both transient forms and navigation unchanged. */
internal suspend fun commitCompletedBack(commit: (() -> Unit)?, awaitCompletion: suspend () -> Unit) {
    try {
        awaitCompletion()
        commit?.invoke()
    } catch (_: CancellationException) { /* Cancelled gesture, not Back. */ }
}
