package io.github.mitzacoder.kemiri.data

import io.github.mitzacoder.kemiri.protocol.Answer
import io.github.mitzacoder.kemiri.protocol.AnswersChangedEvent
import io.github.mitzacoder.kemiri.protocol.AnswersListRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

internal fun answersListRequest(projectId: String, query: String = "", subscribe: Boolean? = null) =
    AnswersListRequest(projectId = projectId, query = query.trim().ifEmpty { null }, subscribe = subscribe)

data class AnswersCatalogue(val answers: List<Answer>? = null, val error: String? = null)

/** One full catalogue per visited project. Search never replaces it or changes its subscription. */
class ProjectAnswers(private val client: HarnessClient, private val projectId: String, scope: CoroutineScope) {
    private val refreshes = Channel<Unit>(Channel.CONFLATED)
    private val mutableCatalogue = MutableStateFlow(AnswersCatalogue())
    val catalogue = mutableCatalogue.asStateFlow()

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            client.events.filterIsInstance<AnswersChangedEvent>().collect { if (it.projectId == projectId) refresh() }
        }
        scope.launch {
            client.state.map {
                if (it.status == ConnectionStatus.Ready && it.supports(HarnessFeature.ANSWERS)) it.generation else null
            }.distinctUntilChanged().collectLatest { generation ->
                if (generation == null) return@collectLatest
                var subscribe: Boolean? = true
                do {
                    try {
                        val answers = client.request(answersListRequest(projectId, subscribe = subscribe)).answers
                        mutableCatalogue.value = AnswersCatalogue(answers)
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
    suspend fun search(query: String): List<Answer> = client.request(answersListRequest(projectId, query)).answers
}
