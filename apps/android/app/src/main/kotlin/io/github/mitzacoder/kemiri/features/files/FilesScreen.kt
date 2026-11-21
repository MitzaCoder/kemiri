package io.github.mitzacoder.kemiri.features.files

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.features.changes.*
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.navigation.rememberPushedList
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.JarvisIconButton
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.delay

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun FilesScreen(context: ProjectScreenContext, route: Destination.Files, modifier: Modifier, back: () -> Unit) {
    val client = context.backend.client
    val project = context.route.projectId
    val connection by client.state.collectAsStateWithLifecycle()
    val supported = connection.supports(PROJECT_FILES)
    val workers = rememberPushedList(client, project, supported && connection.supports("workers"),
        { (it as? WorkersStateEvent)?.takeIf { event -> event.projectId == project }?.workers },
        { client.request(WorkersListRequest(projectId = project)).workers })
    val threads = rememberPushedList(client, project, supported && connection.supports("threads"),
        { (it as? ThreadsStateEvent)?.takeIf { event -> event.projectId == project }?.threads },
        { client.request(ThreadsListRequest(projectId = project)).threads })
    val choices = remember(workers, threads) { checkoutChoices(workers, threads) }
    val checkout = choices.firstOrNull { it.root == route.root }?.label ?: route.root.label()
    var rootMenu by remember { mutableStateOf(false) }
    var searching by rememberSaveable { mutableStateOf(false) }
    var showHidden by rememberSaveable { mutableStateOf(false) }
    val path = route.path
    Scaffold(modifier, topBar = {
        Column {
            TopAppBar(title = { Text("Files", Modifier.semantics { heading() }) }, navigationIcon = {
                JarvisIconButton(Lucide.ArrowLeft, "Back", back)
            }, actions = { TextButton({ searching = true }, enabled = supported) { Text("Go to file") } })
            Box(Modifier.fillMaxWidth().height(2.dp).background(Jarvis.colors.grad()))
        }
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
            if (!supported) {
                ChangesNotice(if (connection.hello == null) "Waiting for this backend…" else "Files are not available on this backend.")
            } else {
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f)) {
                        OutlinedButton({ rootMenu = true }, modifier = Modifier.heightIn(min = 48.dp)) {
                            Text(checkout, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        DropdownMenu(rootMenu, { rootMenu = false }) {
                            choices.forEach { choice -> DropdownMenuItem(text = { Text(choice.label) }, onClick = {
                                rootMenu = false
                                if (choice.root != route.root) context.navigate(route.switchRoot(choice.root))
                            }) }
                        }
                    }
                    if (connection.supports(WORKING_CHANGES) && connection.supports(PROJECT_CHANGES)) {
                        TextButton({ context.navigate(Destination.WorkingChanges(route.chat, route.root, checkout, route.taskId)) }) {
                            Text("Uncommitted changes")
                        }
                    }
                }
                FileBreadcrumb(route.folder, path) { folder -> if (path != null || folder != route.folder) context.navigate(route.browse(folder)) }
                HorizontalDivider()
                if (path == null) {
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("Show hidden", Modifier.weight(1f))
                        Switch(showHidden, { showHidden = it }, Modifier.semantics { contentDescription = "Show hidden" })
                    }
                    FolderEntries(context, route, showHidden)
                } else if (!validCheckoutPath(path)) ChangesNotice("This file path is not available in the checkout.")
                else CheckoutFileViewer(context, route, path)
            }
        }
    }
    if (searching && supported) GoToFileSheet(context, route.root, { searching = false }) {
        searching = false
        context.navigate(route.open(it))
    }
}

@Composable private fun FileBreadcrumb(folder: String, path: String?, browse: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        for ((index, crumb) in checkoutBreadcrumb(folder).withIndex()) {
            if (index > 0) Text("/", color = Jarvis.colors.fgMuted)
            if (path == null && crumb.second == folder) Text(crumb.first, Modifier.padding(horizontal = 12.dp), style = MaterialTheme.typography.titleSmall)
            else TextButton({ browse(crumb.second) }, modifier = Modifier.heightIn(min = 48.dp)) { Text(crumb.first) }
        }
        if (path != null) {
            Text("/", color = Jarvis.colors.fgMuted)
            Text(path.substringAfterLast('/'), Modifier.padding(horizontal = 12.dp), style = MaterialTheme.typography.titleSmall)
        }
    }
}

@Composable private fun FolderEntries(context: ProjectScreenContext, route: Destination.Files, showHidden: Boolean) {
    var attempt by remember { mutableIntStateOf(0) }
    val listing by key(route.root, route.folder, showHidden, attempt) {
        produceState<ChangesRead<FilesListResponse>>(ChangesRead.Loading) {
            value = fetchChanges { context.backend.client.request(FilesListRequest(projectId = route.chat.projectId,
                root = route.root, path = route.folder, showHidden = showHidden)) }
        }
    }
    when (val read = listing) {
        ChangesRead.Loading -> ChangesLoading()
        is ChangesRead.Failed -> ChangesNotice(read.message) { attempt++ }
        is ChangesRead.Ready -> LazyColumn(Modifier.fillMaxSize()) {
            if (read.document.truncated) item { ChangesNotice("This folder reached the listing limit.") }
            if (read.document.entries.isEmpty()) item { ChangesNotice("This folder is empty.") }
            items(read.document.entries, key = { it.name }) { entry ->
                val next = listOf(route.folder, entry.name).filter(String::isNotEmpty).joinToString("/")
                val directory = entry.kind == "dir"
                val type = when (entry.kind) { "dir" -> "folder"; "link" -> "link"; else -> "file" }
                CheckoutRow(entry.name, if (directory) "Folder" else if (entry.kind == "link") "Link" else fileBytes(entry.size), "${entry.name}, $type") {
                    if (validCheckoutPath(next)) context.navigate(if (directory) route.browse(next) else route.open(next))
                }
            }
        }
    }
}

@Composable private fun CheckoutRow(title: String, detail: String, description: String, open: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = open).heightIn(min = 48.dp)
        .semantics { contentDescription = description }.padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).clearAndSetSemantics {}) {
            Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(detail, color = Jarvis.colors.fgMuted, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
    HorizontalDivider(Modifier.padding(start = 16.dp), color = Jarvis.colors.border)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun GoToFileSheet(context: ProjectScreenContext, root: CodeRoot, close: () -> Unit, open: (String) -> Unit) {
    var input by rememberSaveable { mutableStateOf("") }
    val search = fileSearchKey(root, input)
    var attempt by remember { mutableIntStateOf(0) }
    val matches by key(search, attempt) {
        produceState<ChangesRead<FilesSearchResponse>>(ChangesRead.Loading) {
            if (search != null) {
                delay(150)
                value = fetchChanges { context.backend.client.request(FilesSearchRequest(projectId = context.route.projectId, root = search.root, query = search.query)) }
            }
        }
    }
    ModalBottomSheet(close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().imePadding().padding(horizontal = 12.dp, vertical = 8.dp)) {
            Text("Go to file", Modifier.padding(8.dp).semantics { heading() }, style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(input, { input = it.take(256) }, Modifier.fillMaxWidth().padding(bottom = 6.dp), label = { Text("Search this checkout") }, singleLine = true)
            if (search == null) ChangesNotice("Type a file name or path.") else when (val read = matches) {
                ChangesRead.Loading -> ChangesLoading()
                is ChangesRead.Failed -> ChangesNotice(read.message) { attempt++ }
                is ChangesRead.Ready -> LazyColumn(Modifier.heightIn(max = 440.dp)) {
                    val paths = read.document.paths.filter(::validCheckoutPath)
                    if (paths.isEmpty()) item { ChangesNotice("No matching files.") }
                    items(paths, key = { it }) { path -> CheckoutRow(path.substringAfterLast('/'), parentFolder(path).ifEmpty { "Root" }, "$path, file") { open(path) } }
                }
            }
        }
    }
}
