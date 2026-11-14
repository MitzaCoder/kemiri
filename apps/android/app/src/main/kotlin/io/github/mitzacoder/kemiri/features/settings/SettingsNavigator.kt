package io.github.mitzacoder.kemiri.features.settings

import io.github.mitzacoder.kemiri.navigation.Destination

/** Navigation intent, never layout: sections replace siblings, drill-downs always push. */
class SettingsNavigator(
    val open: (Destination) -> Unit,
    val replace: (Destination) -> Unit,
    val up: (Destination) -> Unit,
    val close: () -> Unit,
) {
    fun selectSection(destination: Destination, fromIndex: Boolean) = if (fromIndex) open(destination) else replace(destination)
}
