package io.github.mitzacoder.kemiri.features.answers

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.AnswersCatalogue
import io.github.mitzacoder.kemiri.data.ConnectionStatus
import io.github.mitzacoder.kemiri.features.chat.markdownText
import io.github.mitzacoder.kemiri.features.tasks.LocalTaskLinks
import io.github.mitzacoder.kemiri.features.tasks.taskStateLabel
import io.github.mitzacoder.kemiri.features.tasks.taskStateTone
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideIcon
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.components.TaskStatusDot
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

@Composable
internal fun AnswersProjectTabRow(
    tabs: List<AnswersProjectTab>, selected: AnswersProjectTab, unread: Boolean, taskAttention: Long, select: (AnswersProjectTab) -> Unit,
) {
    SecondaryTabRow(selectedTabIndex = tabs.indexOf(selected)) {
        tabs.forEach { tab ->
            val dot = tab == AnswersProjectTab.Answers && unread
            val count = taskAttention.takeIf { tab == AnswersProjectTab.Tasks && it > 0 }
            Tab(selected == tab, { select(tab) }, modifier = Modifier.semantics {
                if (dot) stateDescription = "Unread answers"
                if (count != null) stateDescription = "$count need attention"
            }, text = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(tab.name)
                    if (count != null) Badge { Text(if (count > 99) "99+" else count.toString()) }
                    if (dot) Box(Modifier.size(7.dp).background(MaterialTheme.colorScheme.primary, CircleShape))
                }
            })
        }
    }
}

@Composable
internal fun AnswersTab(context: ProjectScreenContext, openAnswer: (String) -> Unit, modifier: Modifier = Modifier) {
    val catalogue = context.backend.answers(context.route.projectId)
    val full by catalogue.catalogue.collectAsStateWithLifecycle()
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    var query by rememberSaveable { mutableStateOf("") }
    val term = query.trim()
    var matches by remember(term, connection.generation) { mutableStateOf<AnswersCatalogue?>(null) }
    var searchError by remember(term) { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    val ready = connection.status == ConnectionStatus.Ready
    LaunchedEffect(catalogue, term, full.answers, full.taskQuestions, ready, connection.generation, retry) {
        if (term.isEmpty() || !ready) return@LaunchedEffect
        searchError = null
        delay(250)
        try { matches = catalogue.search(term) }
        catch (error: CancellationException) { throw error }
        catch (error: Exception) { searchError = answerError(error) }
    }
    val shown = if (term.isEmpty()) full else matches
    val error = if (term.isEmpty()) full.error else searchError
    val (today, zone) = rememberAnswerDay()
    val groups = remember(shown, today, zone) { groupAnswers(shown?.answers.orEmpty(), today, zone, shown?.taskQuestions.orEmpty()) }
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        OutlinedTextField(
            value = query, onValueChange = { query = it }, label = { Text("Search answers") }, singleLine = true,
            leadingIcon = { LucideGlyph(Lucide.Search, size = 18.dp) },
            trailingIcon = if (query.isEmpty()) null else {{
                IconButton(onClick = { query = "" }) { LucideGlyph(Lucide.X, size = 18.dp, contentDescription = "Clear search") }
            }},
            modifier = Modifier.widthIn(max = 680.dp).fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        )
        if (!ready) AnswerHint("Offline · showing last loaded data")
        if (error != null) {
            AnswerHint(error, isError = true)
            TextButton(onClick = { if (term.isEmpty()) catalogue.refresh() else retry++ }, enabled = ready) { Text("Retry") }
        }
        if (shown?.answers == null && ready && error == null) LinearProgressIndicator(Modifier.widthIn(max = 680.dp).fillMaxWidth())
        if (shown?.answers != null && groups.isEmpty()) AnswerHint(if (term.isEmpty()) "No answers yet." else "No matching answers.")
        LazyColumn(Modifier.widthIn(max = 680.dp).fillMaxWidth().weight(1f), contentPadding = PaddingValues(bottom = 24.dp)) {
            groups.forEach { group ->
                item(key = group.label) {
                    Text(group.label, Modifier.padding(start = 16.dp, top = 18.dp, bottom = 5.dp).semantics { heading() },
                        style = MaterialTheme.typography.labelLarge, color = Jarvis.colors.fgMuted)
                }
                items(group.entries, key = { it.key }) { entry ->
                    AnswerRow(entry, today, zone, openAnswer, context::openTask)
                    HorizontalDivider(Modifier.padding(horizontal = 16.dp))
                }
            }
        }
    }
}

private val taskQuestionIcon = LucideIcon("message-circle", "M7.9 20A9 9 0 1 0 4 16.1L3 21Z")

@Composable
private fun AnswerRow(entry: AnswerListEntry, today: LocalDate, zone: ZoneId, openAnswer: (String) -> Unit, openTask: (String) -> Unit) {
    val answer = (entry as? AnswerListEntry.SavedAnswer)?.answer
    val question = entry as? AnswerListEntry.TaskQuestion
    val work = answer?.working?.let { rememberAnswerWorkStatus(it, entry.at) }
    val taskId = question?.question?.taskId ?: answer?.taskId ?: answer?.related?.firstOrNull()
    val title = answer?.title ?: question?.title.orEmpty()
    val reply = answer?.answer ?: question?.question?.note ?: "Question on a task"
    val preview = work?.label ?: remember(reply) { markdownText(reply).replace(Regex("\\s+"), " ").trim() }
    val unread = answer?.read == false && work == null
    val weight = if (unread) FontWeight.Bold else FontWeight.Normal
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button) {
        when (entry) {
            is AnswerListEntry.SavedAnswer -> openAnswer(entry.answer.id)
            is AnswerListEntry.TaskQuestion -> openTask(entry.question.taskId)
        }
    }.semantics { if (unread) stateDescription = "Unread" }.padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
        if (work != null) AnswerWorkGlyph(work.indicator, Modifier.padding(top = 2.dp))
        else LucideGlyph(if (question != null) taskQuestionIcon else Lucide.Check,
            Modifier.padding(top = 2.dp), size = 16.dp, tint = Jarvis.colors.accent2)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = MaterialTheme.typography.bodyMedium, fontWeight = weight)
            Text(preview, style = MaterialTheme.typography.bodySmall, color = answerWorkColor(work?.indicator),
                fontWeight = weight, maxLines = if (work == null) 1 else 2, overflow = TextOverflow.Ellipsis)
            taskId?.let { AnswerTaskChip(it, false) { openTask(it) } }
        }
        Text(if (entry.pinned) answerWhen(entry.at, today, zone) else answerTime(entry.at, zone),
            style = MaterialTheme.typography.labelSmall, color = Jarvis.colors.fgMuted, modifier = Modifier.padding(top = 2.dp))
    }
}

@Composable
internal fun AnswerTaskChip(taskId: String, withTitle: Boolean, open: () -> Unit) {
    val task = LocalTaskLinks.current?.task(taskId)
    val title = if (task != null && withTitle) "$taskId ${task.title}" else taskId
    val label = task?.let { "$title · ${taskStateLabel(it)}" } ?: title
    Surface(onClick = open, shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
        Row(Modifier.heightIn(min = 32.dp).padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            if (task != null) TaskStatusDot(taskStateTone(task))
            Text(label, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
internal fun rememberAnswerDay(): Pair<LocalDate, ZoneId> {
    fun currentDay() = ZoneId.systemDefault().let { LocalDate.now(it) to it }
    var clock by remember { mutableStateOf(currentDay()) }
    LaunchedEffect(Unit) { while (true) { delay(30_000); clock = currentDay() } }
    return clock
}

@Composable
internal fun AnswerHint(message: String, isError: Boolean = false) {
    Text(message, Modifier.padding(vertical = 4.dp, horizontal = 16.dp), style = MaterialTheme.typography.bodySmall,
        color = if (isError) MaterialTheme.colorScheme.error else Jarvis.colors.fgMuted)
}

internal fun answerError(error: Exception) = error.message ?: "The backend could not complete the answer request."
