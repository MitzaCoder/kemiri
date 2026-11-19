package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.protocol.BoardLiveLine
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.protocol.BoardTaskActivity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// The trail rules mirror the web's lib/task-live.ts and TaskLive.svelte. Keep the two in step.

/** The divider reads "↑ New since you looked" (the arrow is decoration); TalkBack says where the new lines are. */
internal const val LIVE_DIVIDER_LABEL = "↑ New since you looked"
internal const val LIVE_DIVIDER_DESCRIPTION = "New since you looked: lines above"

/** The newest lines shown under "So far"; the rest wait under "Earlier". */
internal const val LIVE_NEWEST_LIMIT = 3

/** `task-live`: only lines of a kind this version knows are shown; later stages add more kinds. */
internal fun visibleLiveLines(lines: List<BoardLiveLine>): List<BoardLiveLine> = lines.filter { it.kind == "phase" || it.kind == "result" }

/**
 * Whether the Live block replaces the older Now lines: the backend says so, the task is working and its trail exists.
 * The block's Now is the state sentence, or the automatic activity when the sentence is missing.
 */
internal fun taskLiveNow(task: BoardTask, featureEnabled: Boolean, activity: BoardTaskActivity?): BoardTaskActivity? =
    if (featureEnabled && task.live?.lines?.isNotEmpty() == true && task.state?.kind == "working") task.state.sentence ?: activity else null

private val workersSuffix = Regex("""\s*·\s*\+\d+ workers?$""")
private val whitespace = Regex("""\s+""")
private fun normalized(text: String) = text.replace(whitespace, " ").trim().lowercase()

/**
 * The server writes Now as "<name> is <phase>", optionally followed by "· +N workers". A newest phase line that says the
 * same thing adds nothing under Now.
 */
internal fun repeatsNow(line: BoardLiveLine, nowText: String): Boolean {
    if (line.kind != "phase") return false
    val phase = normalized(line.text)
    if (phase.isEmpty()) return false
    val now = normalized(nowText.replace(workersSuffix, ""))
    return now == phase || now.endsWith(" is $phase")
}

internal sealed interface LiveTrailItem {
    data class Line(val line: BoardLiveLine) : LiveTrailItem
    /** The "New since you looked" divider; it sits below the newest `unseen` lines. */
    data object Divider : LiveTrailItem
}

internal data class LiveTrail(
    /** The newest [LIVE_NEWEST_LIMIT] lines, newest first, with the divider in place. */
    val newest: List<LiveTrailItem>,
    /** The rest, newest first, folded under "Earlier". */
    val earlier: List<LiveTrailItem>,
    val earlierLines: Int,
    /** Unseen lines that are folded under "Earlier". */
    val earlierUnseen: Int,
    val unseen: Int,
) {
    val lines: List<BoardLiveLine> get() = (newest + earlier).filterIsInstance<LiveTrailItem.Line>().map { it.line }
}

/**
 * [chronological] is oldest first, as sent. [unseenIds] are the lines after this visit's checkpoint; they are always the
 * newest ones. A newest phase line that repeats Now is left out, and with it its place among the unseen.
 */
internal fun liveTrail(chronological: List<BoardLiveLine>, nowText: String?, unseenIds: Set<String> = emptySet()): LiveTrail {
    val visible = visibleLiveLines(chronological).asReversed()
    val shown = if (nowText != null && visible.firstOrNull()?.let { repeatsNow(it, nowText) } == true) visible.drop(1) else visible
    val unseen = shown.takeWhile { it.id in unseenIds }.size
    val items = ArrayList<LiveTrailItem>(shown.size + 1)
    shown.forEachIndexed { index, line ->
        if (index == unseen && unseen > 0) items += LiveTrailItem.Divider
        items += LiveTrailItem.Line(line)
    }
    if (unseen > 0 && unseen == shown.size) items += LiveTrailItem.Divider
    // The divider belongs to the section that holds the line above it, so a divider after the third line ends So far.
    var cut = 0
    var lines = 0
    for (item in items) {
        if (item is LiveTrailItem.Line) { if (lines == LIVE_NEWEST_LIMIT) break; lines++ }
        cut++
    }
    val newest = items.take(cut)
    val earlier = items.drop(cut)
    val earlierLines = shown.size - minOf(shown.size, LIVE_NEWEST_LIMIT)
    return LiveTrail(newest, earlier, earlierLines, maxOf(0, unseen - LIVE_NEWEST_LIMIT), unseen)
}

/** A line the reader reached: the checkpoint kept per device, backend, project and task. */
internal data class LiveCheckpoint(val id: String, val at: String)

internal fun liveSeenKey(backendKey: String, projectId: String, taskId: String): String =
    JsonArray(listOf(JsonPrimitive(backendKey), JsonPrimitive(projectId), JsonPrimitive(taskId))).toString()

/** Where a device keeps its checkpoints; SharedPreferences in the app. */
internal interface LiveSeenStore {
    fun read(key: String): String?
    fun write(key: String, value: String)
}

internal data class LiveVisitState(val unseenIds: Set<String>, val arrived: Set<String>)

/**
 * One visible visit of a task sheet. The checkpoint moves to the newest line as lines are shown, but the divider keeps
 * the position the visit started at, so it stays put while the lines above it arrive. Make a new visit when the sheet
 * is shown again.
 */
internal class LiveTrailVisit(private val store: LiveSeenStore, private val key: String) {
    private var checkpoint: LiveCheckpoint? = readCheckpoint()
    private var previous: Set<String>? = null
    private var previousNewest: String? = null

    private fun readCheckpoint(): LiveCheckpoint? = runCatching {
        val saved = Json.parseToJsonElement(store.read(key) ?: return null).jsonObject
        val id = saved["id"]?.jsonPrimitive?.contentOrNull
        val at = saved["at"]?.jsonPrimitive?.contentOrNull
        if (id != null && at != null) LiveCheckpoint(id, at) else null
    }.getOrNull()

    /** [chronological] holds only the lines the block shows, oldest first. */
    fun update(chronological: List<BoardLiveLine>): LiveVisitState {
        val newest = chronological.lastOrNull()
        val before = previous
        val arrived = if (before == null) emptySet() else chronological.filter { it.id !in before }.mapTo(linkedSetOf()) { it.id }
        if (newest != null && newest.id != previousNewest) {
            runCatching { store.write(key, JsonObject(mapOf("id" to JsonPrimitive(newest.id), "at" to JsonPrimitive(newest.at))).toString()) }
        }
        if (before == null && checkpoint == null) checkpoint = newest?.let { LiveCheckpoint(it.id, it.at) }
        previous = chronological.mapTo(hashSetOf()) { it.id }
        previousNewest = newest?.id
        val saved = checkpoint
        val seenIndex = if (saved == null) -1 else chronological.indexOfLast { it.id == saved.id }
        // If the checkpoint was evicted or its source ended, older lines of a different run can still be retained.
        val unseen = if (seenIndex >= 0) chronological.drop(seenIndex + 1) else chronological.filter { saved == null || it.at > saved.at }
        return LiveVisitState(unseen.mapTo(hashSetOf()) { it.id }, arrived)
    }
}

/** The spoken form of a line: kind, who, what and how long ago. */
internal fun liveLineDescription(line: BoardLiveLine, age: String): String =
    "${liveKindLabel(line.kind)}, ${line.actor.name}, $age: ${line.text}"

internal fun liveKindLabel(kind: String): String = if (kind == "result") "Result" else "Phase"

internal fun liveNowDescription(now: BoardTaskActivity, age: String): String = "Now: ${now.text}, $age"
