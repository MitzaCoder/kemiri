package io.github.mitzacoder.kemiri.features.coordinators

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.navigation.modelLabel
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.util.UUID

/** Identical retries keep their operation ID, even when the socket response was lost. */
internal class CoordinatorOperations {
    private val attempts = mutableMapOf<Any, String>()
    suspend fun <T> run(mutation: Any, send: suspend (String) -> T): T {
        val id = attempts.getOrPut(mutation) { UUID.randomUUID().toString() }
        return send(id).also { attempts.remove(mutation) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun CoordinatorEditor(context: ProjectScreenContext, thread: ThreadSummary?, dismiss: () -> Unit, areaOnly: Boolean = false, promote: Boolean = false) {
    var title by rememberSaveable(thread?.id) { mutableStateOf(thread?.title.orEmpty()) }
    var area by rememberSaveable(thread?.id) { mutableStateOf(thread?.area.orEmpty()) }
    var paths by rememberSaveable(thread?.id) { mutableStateOf(thread?.paths.orEmpty().joinToString("\n")) }
    var color by rememberSaveable(thread?.id) { mutableStateOf(thread?.color ?: coordinatorColors.getValue("Slate")) }
    var model by remember(thread?.id) { mutableStateOf(thread?.model) }
    var modelMenu by remember { mutableStateOf(false) }
    var colorMenu by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val models by context.backend.models.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val operations = remember { CoordinatorOperations() }
    val client = context.backend.client
    val project = context.route.projectId
    ModalBottomSheet(onDismissRequest = { if (!busy) dismiss() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Jarvis.colors.surface) {
        Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(if (thread == null) "New coordinator" else if (promote) "Keep as coordinator" else if (areaOnly) "Edit area" else "Edit coordinator", style = MaterialTheme.typography.headlineSmall)
            if (!areaOnly) OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth(), label = { Text("Name") }, singleLine = true)
            OutlinedTextField(area, { area = it }, Modifier.fillMaxWidth(), label = { Text("Area") }, placeholder = { Text("What does this coordinator cover?") }, minLines = 2)
            if (!areaOnly && !promote && thread?.main != true) OutlinedTextField(paths, { paths = it }, Modifier.fillMaxWidth(), label = { Text("Paths (optional)") }, placeholder = { Text("One pattern per line") })
            if (!areaOnly) Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box {
                    OutlinedButton(onClick = { colorMenu = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text(coordinatorColors.entries.find { it.value == color }?.key ?: "Colour") }
                    DropdownMenu(colorMenu, { colorMenu = false }) { coordinatorColors.forEach { (name, value) -> DropdownMenuItem(text = { Text(name) }, onClick = { color = value; colorMenu = false }) } }
                }
                if (!promote && thread?.main != true && models.isNotEmpty()) Box {
                    OutlinedButton(onClick = { modelMenu = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text(model?.let { modelLabel(it, models) } ?: "Project model", maxLines = 1) }
                    DropdownMenu(modelMenu, { modelMenu = false }) { models.forEach { choice ->
                        DropdownMenuItem(text = { Text(choice.name) }, onClick = { model = ModelRef(choice.provider, choice.modelId); modelMenu = false })
                    } }
                }
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(enabled = !busy && title.isNotBlank() && area.isNotBlank(), modifier = Modifier.align(Alignment.End).heightIn(min = 48.dp), onClick = {
                val pathPatterns = paths.lineSequence().map(String::trim).filter(String::isNotEmpty).distinct().toList()
                val name = title.trim()
                val coverage = area.trim()
                busy = true
                error = null
                scope.launch {
                    try {
                        if (thread == null) {
                            val request = ThreadsCreateRequest(id = "", projectId = project, title = name, area = coverage, paths = pathPatterns, color = color, model = model)
                            val created = operations.run(request) { client.request(request.copy(id = UUID.randomUUID().toString(), operationId = it)) }.thread
                            dismiss()
                            context.navigate(coordinatorRoute(context.route, created.id))
                        } else {
                            val request = ThreadsUpdateRequest(id = "", projectId = project, threadId = thread.id, title = name.takeUnless { areaOnly }, area = coverage,
                                promote = true.takeIf { promote }, paths = pathPatterns.takeUnless { areaOnly || promote || thread.main }, color = color.takeUnless { areaOnly }, model = model.takeUnless { areaOnly || thread.main }?.takeUnless { it == thread.model })
                            operations.run(request) { client.request(request.copy(id = UUID.randomUUID().toString(), operationId = it)) }
                            dismiss()
                        }
                    } catch (e: CancellationException) { throw e }
                    catch (e: Exception) { error = e.message ?: "Could not save the coordinator" }
                    finally { busy = false }
                }
            }) { Text(if (busy) "Saving…" else if (thread == null) "Create coordinator" else if (promote) "Keep as coordinator" else "Save changes") }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun CoordinatorManager(context: ProjectScreenContext, threads: List<ThreadSummary>, dismiss: () -> Unit) {
    val roster = coordinatorRoster(threads)
    val archived = threads.filter { it.kind == "coordinator" && it.archived }
    val scope = rememberCoroutineScope()
    val operations = remember { CoordinatorOperations() }
    val client = context.backend.client
    val project = context.route.projectId
    val android = LocalContext.current
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<ThreadSummary?>(null) }
    var archiving by remember { mutableStateOf<ThreadSummary?>(null) }
    fun mutate(action: suspend () -> Unit) {
        busy = true
        error = null
        scope.launch {
            try { action() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = e.message ?: "Could not change the coordinator" }
            finally { busy = false }
        }
    }
    fun archive(thread: ThreadSummary, archived: Boolean, moveTo: String? = null, schedules: String? = null) = mutate {
        val request = ThreadsArchiveRequest(id = "", projectId = project, threadId = thread.id, archived = archived, moveTasksTo = moveTo, schedules = schedules)
        operations.run(request) { client.request(request.copy(id = UUID.randomUUID().toString(), operationId = it)) }
        if (archived) forgetCoordinatorVisit(android, context.route, thread.id)
        archiving = null
    }
    fun reorder(thread: ThreadSummary, position: Int) = mutate {
        val order = roster.filterNot { it.main }.toMutableList().apply { remove(thread); add(position, thread) }
        order.forEachIndexed { index, row ->
            val rank = index.toLong() + 1
            if (row.order != rank) {
                val request = ThreadsUpdateRequest(id = "", projectId = project, threadId = row.id, order = rank)
                operations.run(request) { client.request(request.copy(id = UUID.randomUUID().toString(), operationId = it)) }
            }
        }
    }
    ModalBottomSheet(onDismissRequest = { if (!busy) dismiss() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Jarvis.colors.surface) {
        LazyColumn(contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item { Text("Manage coordinators", style = MaterialTheme.typography.headlineSmall) }
            error?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
            items(roster, key = { it.id }) { thread ->
                val index = roster.indexOf(thread) - 1
                Column(Modifier.fillMaxWidth()) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) { CoordinatorMark(thread); Text(thread.title, style = MaterialTheme.typography.titleMedium) }
                    thread.area?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted) }
                    FlowRow {
                        TextButton(onClick = { editing = thread }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Edit") }
                        if (!thread.main) {
                            TextButton(onClick = { reorder(thread, index - 1) }, enabled = !busy && index > 0, modifier = Modifier.heightIn(min = 48.dp)) { Text("Move up") }
                            TextButton(onClick = { reorder(thread, index + 1) }, enabled = !busy && index < roster.size - 2, modifier = Modifier.heightIn(min = 48.dp)) { Text("Move down") }
                            TextButton(onClick = { mutate {
                                val request = ThreadsHoldRequest(id = "", projectId = project, threadId = thread.id, held = thread.held != true)
                                operations.run(request) { client.request(request.copy(id = UUID.randomUUID().toString(), operationId = it)) }
                            } }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (thread.held == true) "Resume" else "Pause") }
                            TextButton(onClick = { archiving = thread }, enabled = !busy && !coordinatorBadges(thread).working, modifier = Modifier.heightIn(min = 48.dp)) { Text("Archive") }
                        }
                    }
                    HorizontalDivider()
                }
            }
            if (archived.isNotEmpty()) item { Text("Archived", style = MaterialTheme.typography.titleMedium) }
            items(archived, key = { it.id }) { thread ->
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(thread.title, Modifier.weight(1f))
                    TextButton(onClick = { archive(thread, false) }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text("Restore") }
                }
            }
            if (client.supports("coordinator-messages")) item { CoordinatorMessageFeed(context, threads) }
        }
    }
    editing?.let { CoordinatorEditor(context, it, dismiss = { editing = null }) }
    archiving?.let { thread ->
        var destination by remember(thread.id) { mutableStateOf(MAIN_THREAD_ID) }
        var schedules by rememberSaveable(thread.id) { mutableStateOf("move") }
        val supportsSchedules = client.supports("coordinator-schedules")
        AlertDialog(onDismissRequest = { if (!busy) archiving = null }, title = { Text("Archive ${thread.title}?") }, text = {
            Column(Modifier.heightIn(max = 330.dp).verticalScroll(rememberScrollState())) {
                Text("Move its open tasks to:")
                roster.filterNot { it.id == thread.id }.forEach { target ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = destination == target.id, onClick = { destination = target.id }, enabled = !busy)
                        Text(target.title)
                    }
                }
                if (supportsSchedules) {
                    Text("Schedules", style = MaterialTheme.typography.titleSmall)
                    listOf("move" to "Move to ${roster.firstOrNull { it.main }?.title ?: "General"}", "disable" to "Turn off schedules").forEach { (choice, label) ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = schedules == choice, onClick = { schedules = choice }, enabled = !busy)
                            Text(label)
                        }
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        }, confirmButton = { TextButton(onClick = { archive(thread, true, destination, schedules.takeIf { supportsSchedules }) }, enabled = !busy) { Text("Archive") } },
            dismissButton = { TextButton(onClick = { archiving = null }, enabled = !busy) { Text("Cancel") } })
    }
}
