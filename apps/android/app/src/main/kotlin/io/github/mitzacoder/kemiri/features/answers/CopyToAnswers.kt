package io.github.mitzacoder.kemiri.features.answers

import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.ConnectionStatus
import io.github.mitzacoder.kemiri.data.supportsAnswersWorkAndTasks
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.BoardTask
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun CopyToAnswers(context: ProjectScreenContext, task: BoardTask) {
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    if (!canCopyToAnswers(connection.supportsAnswersWorkAndTasks(), task.parent, task.status)) return
    val scope = rememberCoroutineScope()
    var copying by remember { mutableStateOf(false) }
    var copyError by remember { mutableStateOf<String?>(null) }
    OutlinedButton(enabled = !copying && connection.status == ConnectionStatus.Ready, onClick = {
        if (!copying) {
            copying = true
            copyError = null
            scope.launch {
                try {
                    val answerId = context.backend.answers(context.route.projectId).copyFromTask(task.id)
                    context.navigate(Destination.Answers(context.route.copy(workerId = null), answerId))
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    copyError = "Could not copy: ${answerError(error)}"
                } finally {
                    copying = false
                }
            }
        }
    }) { Text(if (copying) "Copying…" else "Copy to Answers") }
    copyError?.let { AnswerHint(it, isError = true) }
}
