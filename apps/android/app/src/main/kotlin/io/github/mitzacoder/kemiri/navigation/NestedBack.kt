package io.github.mitzacoder.kemiri.navigation

import androidx.compose.runtime.*

/** Transient sub-views share the app bar/system target. Dialog windows retain native precedence. */
internal val LocalNestedBackTargets = compositionLocalOf<MutableList<NestedBackTarget>?> { null }

/** Higher depth wins regardless of when an enclosing view recomposes. Never register secrets. */
@Composable
internal fun NestedBackHandler(enabled: Boolean, depth: Int, parentLabel: String? = null, onBack: () -> Unit) {
    val targets = LocalNestedBackTargets.current
    val latestBack by rememberUpdatedState(onBack)
    DisposableEffect(targets, enabled, depth, parentLabel) {
        val target = NestedBackTarget(depth, parentLabel) { latestBack() }
        if (enabled) targets?.add(target)
        onDispose { targets?.remove(target) }
    }
}
