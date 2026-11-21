package io.github.mitzacoder.kemiri.features.changes

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.mitzacoder.kemiri.features.chat.ChatHighlighter
import io.github.mitzacoder.kemiri.protocol.ChangedFile
import io.github.mitzacoder.kemiri.ui.components.JarvisIconButton
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

internal val changeCodeStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 19.sp,
    lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None))
private val changeLineHeight = 19.dp

@Composable internal fun highlightedChangeLines(lines: List<String>, path: String): List<AnnotatedString> {
    val assets = LocalContext.current.assets
    val dark = Jarvis.colors.dark
    return key(path, dark) {
        val spans by produceState(emptyList<AnnotatedString>(), lines, assets) {
            value = emptyList()
            value = highlightChangeDocument(lines, path, dark) { text, language, theme ->
                ChatHighlighter.highlight(text, language, theme, assets)
            }
        }
        spans
    }
}

@Composable internal fun UnifiedChangeDiff(diff: ChangeDiff, path: String, previousPath: String?, comments: List<CodeComment>, source: CodeReviewSource,
                                          selection: CodeAnchor?, onComment: (ChangeLine, Boolean) -> Unit, onPin: () -> Unit) {
    // Queue the destination first: it supplies both context and added lines in the unified diff.
    val after = highlightedChangeLines(diff.after, path)
    val before = highlightedChangeLines(diff.before, previousPath ?: path)
    val pinLines = remember(comments, source, path) {
        comments.withIndex().filter { !it.value.outdated && it.value.source == source && it.value.anchor.path == path }
            .groupBy { it.value.anchor.side to it.value.anchor.startLine }
    }
    fun pins(line: ChangeLine): List<Int> = buildList {
        line.before?.let { pinLines["before" to it]?.forEach { pin -> add(pin.index + 1) } }
        line.after?.let { pinLines["after" to it]?.forEach { pin -> add(pin.index + 1) } }
    }
    val bands = remember(diff, pinLines, selection) {
        val pinned = if (pinLines.isEmpty() && selection == null) emptySet() else buildSet {
            diff.lines.forEachIndexed { i, line ->
                if ((line.before != null && pinLines.containsKey("before" to line.before)) ||
                    (line.after != null && pinLines.containsKey("after" to line.after)) ||
                    (selection != null && (if (selection.side == "before") line.before else line.after) == selection.startLine)) add(i)
            }
        }
        diffBands(diff.lines, pinned)
    }
    var expanded by remember(diff) { mutableStateOf(emptySet<Int>()) }
    val visibleBands = remember(bands, expanded) {
        if (expanded.isEmpty()) bands else bands.flatMap { band ->
            if (band.folded && band.start in expanded) (band.start until band.endExclusive).map { DiffBand(it, it + 1) } else listOf(band)
        }
    }
    LazyColumn(Modifier.fillMaxWidth().fillMaxHeight(), contentPadding = PaddingValues(bottom = 12.dp)) {
        if (diff.approximate) item { ChangesNotice("This diff was simplified because it has too many changes to align on this device.") }
        items(visibleBands, key = { it.start }) { band ->
            if (band.folded) {
                TextButton(onClick = { expanded = expanded + band.start }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Text("${band.endExclusive - band.start} unchanged lines · Show")
                }
            } else {
                val line = diff.lines[band.start]
                val highlighted = if (line.after != null) after.getOrNull(line.after - 1) else before.getOrNull(line.number - 1)
                val selected = selection?.let { (if (it.side == "before") line.before else line.after) == it.startLine } == true
                ChangeDiffLine(line, highlighted, diff.wordMarks[band.start].orEmpty(), pins(line), selected, onComment, onPin)
            }
        }
    }
}

@Composable private fun ChangeDiffLine(line: ChangeLine, highlighted: AnnotatedString?, marks: List<IntRange>, pins: List<Int>,
                                       selected: Boolean, onComment: (ChangeLine, Boolean) -> Unit, onPin: () -> Unit) {
    val colors = Jarvis.colors
    val accent = if (line.unchanged) Color.Transparent else if (line.after == null) colors.danger else colors.success
    val description = "${line.side.replaceFirstChar(Char::titlecase)} line ${line.number}" + when {
        line.unchanged -> ""
        line.after == null -> ", removed"
        else -> ", added"
    }
    ReviewCodeLine(line.number, line.text, description, highlighted, marks, line.sign, accent, pins, selected,
        onComment = { onComment(line, it) }, onPin = onPin)
}

@OptIn(ExperimentalFoundationApi::class)
@Composable internal fun ReviewCodeLine(number: Int, text: String, description: String, highlighted: AnnotatedString?,
                                       marks: List<IntRange> = emptyList(), sign: String? = null, accent: Color = Color.Transparent,
                                       pins: List<Int> = emptyList(), selected: Boolean = false, onComment: (Boolean) -> Unit, onPin: () -> Unit) {
    val colors = Jarvis.colors
    val primary = MaterialTheme.colorScheme.primary
    val marked = remember(highlighted, text, marks, accent) {
        changeLineText(text, highlighted, marks, accent.copy(alpha = 0.28f))
    }
    Row(Modifier.fillMaxWidth().heightIn(min = changeLineHeight)
        .background(if (selected) primary.copy(alpha = 0.15f) else accent.copy(alpha = if (accent == Color.Transparent) 0f else 0.10f))
        .semantics(mergeDescendants = true) {
            contentDescription = description
            if (selected) stateDescription = "Range start"
            onClick(label = "Comment on line") { onComment(false); true }
            onLongClick(label = "Start line range") { onComment(true); true }
            if (pins.isNotEmpty()) customActions = listOf(CustomAccessibilityAction(
                "Review comments ${pins.joinToString()} on line $number", { onPin(); true },
            ))
        }, verticalAlignment = Alignment.Top) {
        // Widen the gutter instead of reserving a 48 dp vertical control on every code line.
        Text(number.toString(), Modifier.alignByBaseline().widthIn(min = 56.dp).clearAndSetSemantics {}
            .combinedClickable(onClick = { onComment(false) }, onLongClick = { onComment(true) }),
            color = colors.fgMuted, style = changeCodeStyle, textAlign = TextAlign.Center)
        if (sign != null) Text(sign, Modifier.alignByBaseline().padding(end = 6.dp).clearAndSetSemantics {}, style = changeCodeStyle, color = accent)
        Text(marked, Modifier.alignByBaseline().weight(1f).padding(end = 10.dp), style = changeCodeStyle, color = colors.fg)
        if (pins.isNotEmpty()) Text(pins.take(2).joinToString(",") + if (pins.size > 2) "…" else "",
            Modifier.alignByBaseline().widthIn(min = 48.dp).clearAndSetSemantics {}.clickable(onClick = onPin),
            color = primary, style = changeCodeStyle, textAlign = TextAlign.Center)
    }
}

@Composable internal fun PlainChangePatch(patch: String?, truncated: Boolean) {
    val lines = remember(patch) { patch?.let(::codeLines).orEmpty() }
    LazyColumn(Modifier.fillMaxWidth(), contentPadding = PaddingValues(bottom = 12.dp)) {
        item { ChangesNotice(if (patch == null) "This file is too large. No patch is available." else if (truncated) "This file is too large. Showing a partial plain patch." else "This file is too large. Showing the plain patch.") }
        itemsIndexed(lines) { _, line -> Text(line, Modifier.fillMaxWidth().padding(horizontal = 12.dp), style = changeCodeStyle) }
    }
}

@Composable internal fun ChangeFileBar(file: ChangedFile, index: Int, total: Int, onFiles: () -> Unit, previous: () -> Unit, next: () -> Unit) {
    val colors = Jarvis.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        JarvisIconButton(Lucide.ArrowLeft, "Previous file", previous, enabled = index > 0)
        Column(Modifier.weight(1f).clickable(role = Role.Button, onClickLabel = "Open changed files", onClick = onFiles)
            .heightIn(min = 48.dp).padding(horizontal = 4.dp, vertical = 5.dp), verticalArrangement = Arrangement.Center) {
            Text(file.path.substringAfterLast('/'), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall)
            Text("File ${index + 1} of $total · +${file.additions} −${file.deletions}", color = colors.fgMuted, style = MaterialTheme.typography.labelMedium)
        }
        JarvisIconButton(Lucide.ChevronRight, "Next file", next, enabled = index + 1 < total)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun ChangeFilesSheet(files: List<ChangedFile>, selectedPath: String?, viewed: (String) -> Boolean,
                                         onViewed: (String, Boolean) -> Unit, open: (String) -> Unit, close: () -> Unit) {
    val groups = remember(files) { groupChangedFiles(files) }
    val colors = Jarvis.colors
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        LazyColumn(Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)) {
            item {
                Text("Changed files", Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge)
                Text("${files.count { viewed(it.path) }} of ${files.size} viewed", Modifier.padding(bottom = 12.dp), color = colors.fgMuted)
            }
            for ((folder, entries) in groups) {
                item { Text(folder.ifEmpty { "Project root" }, Modifier.padding(top = 12.dp, bottom = 4.dp).semantics { heading() }, style = MaterialTheme.typography.labelLarge, color = colors.fgMuted) }
                items(entries, key = { it.path }) { file ->
                    val name = file.path.substringAfterLast('/')
                    val check = viewed(file.path)
                    val accent = when (file.status) { "added" -> colors.success; "deleted" -> colors.danger; "modified" -> colors.warning; else -> MaterialTheme.colorScheme.primary }
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Row(Modifier.weight(1f).clickable(role = Role.Button) { open(file.path) }.heightIn(min = 52.dp).padding(vertical = 4.dp)
                            .semantics {
                                contentDescription = "$name, ${file.status}, ${file.additions} added, ${file.deletions} removed"
                                if (selectedPath == file.path) stateDescription = "Open file"
                            }, verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(28.dp).background(accent.copy(alpha = 0.12f), RoundedCornerShape(7.dp)), contentAlignment = Alignment.Center) {
                                Text(file.status.firstOrNull()?.uppercase().orEmpty(), Modifier.clearAndSetSemantics {}, color = colors.fg, style = MaterialTheme.typography.labelMedium)
                            }
                            Column(Modifier.padding(start = 10.dp).clearAndSetSemantics {}) {
                                Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text("+${file.additions} −${file.deletions}", color = colors.fgMuted, style = MaterialTheme.typography.labelMedium)
                            }
                        }
                        Checkbox(check, { onViewed(file.path, it) }, Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                            .semantics { contentDescription = "Viewed: $name" })
                    }
                }
            }
        }
    }
}
