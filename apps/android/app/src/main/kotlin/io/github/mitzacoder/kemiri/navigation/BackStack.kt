package io.github.mitzacoder.kemiri.navigation

import io.github.mitzacoder.kemiri.features.settings.GeneralPage
import io.github.mitzacoder.kemiri.features.settings.GeneralSection
import io.github.mitzacoder.kemiri.features.settings.ProjectSection
import kotlinx.serialization.Serializable

/** A visit includes cross-tree settings detours, but never stores form fields or credentials. */
@Serializable
data class SettingsVisit(val originIndex: Int?, val fallback: Destination)

/** Width-independent navigation. Persist this whole value, not just the visible destination. */
@Serializable
data class BackStack(
    val entries: List<Destination> = listOf(Destination.Home),
    val settingsVisit: SettingsVisit? = null,
) {
    init { require(entries.isNotEmpty()) }
    val current: Destination get() = entries.last()
    val canGoBack: Boolean get() = entries.size > 1

    fun push(child: Destination): BackStack {
        if (child == current) return this
        val visit = if (child.isSettings()) settingsVisit ?: if (current.isSettings()) {
            SettingsVisit(null, current.settingsFallback())
        } else SettingsVisit(entries.lastIndex, child.settingsFallback()) else null
        return capped(entries + child, visit)
    }

    fun replaceSibling(sibling: Destination): BackStack {
        if (sibling == current) return this
        val visit = if (sibling.isSettings()) settingsVisit ?: SettingsVisit(null, if (current.isSettings()) current.settingsFallback() else sibling.settingsFallback()) else null
        return copy(entries = entries.dropLast(1) + sibling, settingsVisit = visit)
    }

    /** Resolve only a newly opened index, never an Up, Back or restored entry. */
    fun withSettingsDefault(split: Boolean): BackStack {
        if (!split) return this
        val section = when (val destination = current) {
            is Destination.Settings -> if (destination.page == GeneralPage()) {
                Destination.Settings(GeneralPage(GeneralSection.entries.first()))
            } else return this
            is Destination.ProjectSettings -> if (destination.section == null && destination.scheduleId == null && destination.unavailableSection == null) {
                destination.copy(section = ProjectSection.entries.first())
            } else return this
            else -> return this
        }
        return replaceSibling(section)
    }

    fun back(): BackStack = if (canGoBack) trimTo(entries.lastIndex - 1) else this

    fun up(parent: Destination): BackStack {
        val start = if (settingsVisit != null) settingsVisit.originIndex?.plus(1) ?: 0 else entries.lastIndex
        val parentIndex = (entries.lastIndex downTo start).firstOrNull { entries[it] == parent }
        return if (parentIndex != null) trimTo(parentIndex) else replaceSibling(parent)
    }

    fun close(): BackStack {
        val origin = settingsVisit?.originIndex
        return if (origin != null && origin in 0 until entries.lastIndex) trimTo(origin)
        else if (settingsVisit != null) BackStack(listOf(settingsVisit.fallback))
        else copy(entries = entries.dropLast(1) + current.settingsFallback())
    }

    private fun trimTo(index: Int): BackStack = copy(
        entries = entries.take(index + 1),
        settingsVisit = settingsVisit?.takeUnless { it.originIndex != null && index <= it.originIndex },
    )

    private fun capped(next: List<Destination>, visit: SettingsVisit?): BackStack {
        val removed = (next.size - 30).coerceAtLeast(0)
        return BackStack(next.takeLast(30), visit?.copy(originIndex = visit.originIndex?.minus(removed)?.takeIf { it >= 0 }))
    }
}

fun Destination.isSettings(): Boolean = this is Destination.Settings || this is Destination.ProjectSettings

private fun Destination.settingsFallback(): Destination = when (this) {
    is Destination.ProjectSettings -> Destination.Chat(chat.backendKey, chat.projectId)
    else -> Destination.Home
}

/** External routes have a deliberate base, never a guessed in-memory origin from another visit. */
fun settingsLinkStack(destination: Destination): BackStack = when (destination) {
    is Destination.ProjectSettings -> BackStack(listOf(Destination.Chat(destination.chat.backendKey, destination.chat.projectId))).push(destination)
    is Destination.Settings -> BackStack().push(destination)
    else -> BackStack().push(destination)
}
