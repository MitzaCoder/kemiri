package io.github.mitzacoder.kemiri.data

import io.github.mitzacoder.kemiri.protocol.Answer
import io.github.mitzacoder.kemiri.protocol.AnswersChangedEvent
import io.github.mitzacoder.kemiri.protocol.AnswersCopyFromTaskRequest
import io.github.mitzacoder.kemiri.protocol.AnswersListRequest
import io.github.mitzacoder.kemiri.protocol.AnswersListResponse
import io.github.mitzacoder.kemiri.protocol.BoardStateEvent
import io.github.mitzacoder.kemiri.protocol.TaskAnswerQuestion
import io.github.mitzacoder.kemiri.protocol.WorkersStateEvent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

internal fun answersListRequest(projectId: String, query: String = "", subscribe: Boolean? = null) =
    AnswersListRequest(projectId = projectId, query = query.trim().ifEmpty { null }, subscribe = subscribe)

internal fun copyAnswerFromTaskRequest(projectId: String, taskId: String) =
    AnswersCopyFromTaskRequest(projectId = projectId, taskId = taskId)

internal fun ConnectionState.supportsAnswersWorkAndTasks() =
    supports(HarnessFeature.ANSWERS) && supports(HarnessFeature.ANSWERS_WORK_AND_TASKS)

data class AnswersCatalogue(
    val answers: List<Answer>? = null,
    val taskQuestions: List<TaskAnswerQuestion> = emptyList(),
    val error: String? = null,
)

internal fun AnswersListResponse.toCatalogue(extended: Boolean) = if (extended) {
    AnswersCatalogue(answers, taskQuestions.orEmpty())
} else {
    AnswersCatalogue(answers.filter { it.working == null })
}

/** One full catalogue per visited project. Search never replaces it or changes its subscription. */
class ProjectAnswers(private val client: HarnessClient, private val projectId: String, scope: CoroutineScope) {
    private val refreshes = Channel<Unit>(Channel.CONFLATED)
    private val mutableCatalogue = MutableStateFlow(AnswersCatalogue())
    val catalogue = mutableCatalogue.asStateFlow()

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            var feedbackRevisions: Map<String, Long?>? = null
            client.events.collect { event ->
                val extended = client.state.value.supportsAnswersWorkAndTasks()
                when (event) {
                    is AnswersChangedEvent -> if (event.projectId == projectId) refresh()
                    is BoardStateEvent -> if (extended && event.projectId == projectId) {
                        val revisions = event.board.tasks.filter { it.feedback != null }.associate { it.id to it.timelineRevision }
                        if (revisions != feedbackRevisions) {
                            feedbackRevisions = revisions
                            refresh()
                        }
                    }
                    is WorkersStateEvent -> if (extended && event.projectId == projectId &&
                        mutableCatalogue.value.answers.orEmpty().any { it.working?.workerId != null }) refresh()
                    else -> Unit
                }
            }
        }
        scope.launch {
            client.state.map {
                if (it.status == ConnectionStatus.Ready && it.supports(HarnessFeature.ANSWERS))
                    it.generation to it.supportsAnswersWorkAndTasks() else null
            }.distinctUntilChanged().collectLatest { subscription ->
                val (_, extended) = subscription ?: return@collectLatest
                if (!extended) mutableCatalogue.update { old ->
                    old.copy(answers = old.answers?.filter { it.working == null }, taskQuestions = emptyList())
                }
                var subscribe: Boolean? = true
                do {
                    try {
                        mutableCatalogue.value = client.request(answersListRequest(projectId, subscribe = subscribe)).toCatalogue(extended)
                        subscribe = null
                    } catch (error: CancellationException) { throw error }
                    catch (error: Exception) {
                        mutableCatalogue.update { it.copy(error = error.message ?: "Could not load answers.") }
                    }
                } while (refreshes.receiveCatching().isSuccess)
            }
        }
    }

    fun refresh() { refreshes.trySend(Unit) }
    suspend fun search(query: String): AnswersCatalogue {
        val extended = client.state.value.supportsAnswersWorkAndTasks()
        return client.request(answersListRequest(projectId, query)).toCatalogue(extended)
    }

    internal suspend fun copyFromTask(taskId: String): String {
        check(client.state.value.supportsAnswersWorkAndTasks()) { "This backend does not support copying tasks to Answers." }
        val copied = client.request(copyAnswerFromTaskRequest(projectId, taskId))
        refresh()
        return copied.answerId
    }
}
