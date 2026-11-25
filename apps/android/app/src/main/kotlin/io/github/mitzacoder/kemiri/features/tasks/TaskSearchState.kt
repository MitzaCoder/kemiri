package io.github.mitzacoder.kemiri.features.tasks

import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.*
import androidx.compose.ui.platform.LocalContext
import io.github.mitzacoder.kemiri.data.readTaskTimeline
import io.github.mitzacoder.kemiri.features.refs.LocalRefLinks
import io.github.mitzacoder.kemiri.features.refs.title
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

internal val LocalTaskSearchHits = compositionLocalOf<Map<String, TaskSearchHit>> { emptyMap() }
internal class TaskSearchState(initial: String, val save: (String) -> Unit) {
    var query by mutableStateOf(initial)
    val feedback = mutableStateMapOf<String, Pair<Long, String>>()
    fun change(text: String) { query = text; save(text) }
}
private val projectSearches = mutableMapOf<String, TaskSearchState>()

@Composable
internal fun taskSearchState(context: ProjectScreenContext): TaskSearchState {
    val key = "${context.backend.config.key}/${context.route.projectId}"
    val preferences = LocalContext.current.applicationContext.getSharedPreferences("aiki.task-search.v1", Context.MODE_PRIVATE)
    return remember(key) { projectSearches.getOrPut(key) { TaskSearchState(preferences.getString(key, "").orEmpty()) { preferences.edit().putString(key, it).apply() } } }
}

private data class IndexedTasks(val documents: List<TaskSearchDocument>, val index: TaskSearchIndex)

@Composable
internal fun taskSearchHits(context: ProjectScreenContext, state: TaskSearchState, tasks: List<BoardTask>, eligible: Set<String>): List<TaskSearchHit> {
    val query = state.query
    if (query.isBlank()) return emptyList()
    val refs = LocalRefLinks.current
    val feedback = state.feedback.toMap()
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val activityEnabled = connection.supports("task-activity")
    // Snapshot ref titles on the UI thread; build documents and tokenize them off it.
    val refTitles = tasks.flatMap { it.refs }.distinct().associateWith { ref -> refs?.status(ref)?.title }
    val indexed by produceState<IndexedTasks?>(null, tasks, Triple(refTitles, feedback, activityEnabled)) {
        val previous = value
        value = withContext(Dispatchers.Default) {
            val documents = tasks.map { task ->
                TaskSearchDocument(task.id, task.title, task.refs.flatMap { ref -> listOfNotNull(ref, refTitles[ref]) },
                    listOf(task.description, taskNowText(task, activityEnabled), task.report.results, task.report.next, feedback[task.id]?.second.orEmpty()).joinToString("\n"), task.parent)
            }
            if (previous?.documents == documents) previous else IndexedTasks(documents, TaskSearchIndex().also { it.update(documents) })
        }
    }
    LaunchedEffect(context.board, tasks.map { it.id to it.timelineRevision }) {
        val pending = tasks.filter { task -> task.feedback?.let { it.open + it.handling + it.addressed + it.dismissed > 0 } == true && state.feedback[task.id]?.first != (task.timelineRevision ?: 0L) }.iterator()
        coroutineScope {
            repeat(4) { launch {
                while (pending.hasNext()) {
                    val task = pending.next()
                    try {
                        val timeline = context.backend.client.readTaskTimeline(context.route.projectId, task.id)
                        state.feedback[task.id] = (task.timelineRevision ?: 0L) to timeline.feedback.joinToString("\n") { it.text }
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { /* Retry on the next board update. */ }
                }
            } }
        }
    }
    val hits by produceState<Pair<String, List<TaskSearchHit>>?>(null, indexed, query, eligible) {
        value = query to withContext(Dispatchers.Default) { indexed?.index?.search(query, eligible).orEmpty() }
    }
    return hits?.takeIf { it.first == query }?.second.orEmpty()
}

@Composable
internal fun TaskSearchBox(state: TaskSearchState) {
    OutlinedTextField(state.query, state::change, label = { Text("Search tasks") }, singleLine = true,
        modifier = Modifier.fillMaxWidth().onPreviewKeyEvent { event ->
            if (event.key == Key.Escape && event.type == KeyEventType.KeyDown) { state.change(""); true } else false
        }, trailingIcon = { if (state.query.isNotEmpty()) TextButton(onClick = { state.change("") }) { Text("Clear") } })
}
