package io.github.mitzacoder.kemiri.features.notifications

import io.github.mitzacoder.kemiri.HarnessApplication
import io.github.mitzacoder.kemiri.data.BoardView
import io.github.mitzacoder.kemiri.data.HarnessFeature
import io.github.mitzacoder.kemiri.data.ClientException
import io.github.mitzacoder.kemiri.data.ConnectionStatus
import io.github.mitzacoder.kemiri.data.HarnessClient
import io.github.mitzacoder.kemiri.data.SignedInSocket
import io.github.mitzacoder.kemiri.protocol.AnswersUpdateRequest
import io.github.mitzacoder.kemiri.protocol.AnswersUpdateResponse
import io.github.mitzacoder.kemiri.protocol.BoardGetRequest
import io.github.mitzacoder.kemiri.protocol.BoardGetResponse
import io.github.mitzacoder.kemiri.protocol.BoardLaterSetRequest
import io.github.mitzacoder.kemiri.protocol.BoardLaterSetResponse
import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.protocol.BoardQuestionAnswerRequest
import io.github.mitzacoder.kemiri.protocol.BoardQuestionAnswerResponse
import io.github.mitzacoder.kemiri.protocol.ConversationSubmitRequest
import io.github.mitzacoder.kemiri.protocol.ConversationSubmitResponse
import io.github.mitzacoder.kemiri.protocol.MAIN_THREAD_ID
import io.github.mitzacoder.kemiri.protocol.NotificationsInteractionRequest
import io.github.mitzacoder.kemiri.protocol.NotificationsInteractionRequestReadChat
import io.github.mitzacoder.kemiri.protocol.NotificationsInteractionResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonPrimitive

@kotlinx.serialization.Serializable
internal enum class PushActionResult { Sent, Stale, ReadInApp, Offline, SignedOut, Rejected, Unconfirmed, StorageUnavailable }

/** Recheck live question type as well as the signed push metadata. An ordinary answer never approves a tool or run. */
internal fun BoardQuestion.canAnswerFromShade() = kind != "warning" && mcpApproval != true && outsideModelApproval != true && usageDrainIncident == null

private val authenticationErrors = setOf("auth_required", "auth_revoked", "auth_invalid", "auth_expired", "forbidden")
private val uncertainErrors = setOf("timeout", "disconnected", "invalid_response")

private suspend fun authenticatePushAction(app: HarnessApplication, action: PendingPushAction): HarnessClient? {
    val binding = action.binding ?: return null
    if (app.notificationActionBinding(action.payload.backendKey) != binding) return null
    val repository = app.repository
    if (withTimeoutOrNull(5_000) { repository.loaded.first { it } } != true) throw ClientException("not_ready", "Settings not loaded")
    val client = repository.session(action.payload.backendKey)?.client ?: return null
    val state = withTimeoutOrNull(8_000) { client.state.first { it.status == ConnectionStatus.Ready || it.status == ConnectionStatus.Closed } }
        ?: throw ClientException("not_ready", "Computer unreachable")
    val hello = state.hello ?: return null
    if (state.status != ConnectionStatus.Ready || hello.backendId != binding.backendId || hello.auth?.sessionId != binding.sessionId) return null
    return client
}

internal suspend fun deliverPushAction(app: HarnessApplication, action: PendingPushAction): PushActionResult {
    val payload = action.payload
    val project = payload.projectId ?: return PushActionResult.Rejected
    var mayHaveCommitted = false
    try {
        val chatRead = action.kind == PushActionKind.MarkRead && payload.answerId == null
        if (chatRead) {
            val entry = payload.entryId ?: return PushActionResult.Sent
            val repository = app.repository
            if (withTimeoutOrNull(5_000) { repository.loaded.first { it } } != true) return PushActionResult.Offline
            repository.markSeen(payload.backendKey, project, entry)
            if (action.binding == null) return PushActionResult.Sent
        }
        val client = authenticatePushAction(app, action) ?: return PushActionResult.SignedOut
        if (!pushActionsUnlocked(app)) return PushActionResult.Offline
        val binding = requireNotNull(action.binding)
        val identity = SignedInSocket(binding.backendId, binding.sessionId)
        when (action.kind) {
            PushActionKind.Answer -> {
                val question = payload.question?.takeIf { pushQuestionActions(payload) != null } ?: return PushActionResult.ReadInApp
                val read = BoardGetRequest(projectId = project)
                val latest = client.exchangeAsSession(identity, read.id, read, BoardGetRequest.serializer(), BoardGetResponse.serializer())
                    .board.questions.firstOrNull { it.id == question.id }
                    ?: return PushActionResult.Stale
                if (!latest.canAnswerFromShade()) return PushActionResult.ReadInApp
                if (latest.waitingOn == "agent") return PushActionResult.Stale
                if (!pushActionsUnlocked(app)) return PushActionResult.Offline
                // Let the mutation atomically reject an older revision or already settled question.
                mayHaveCommitted = true
                val request = action.answerRequest(project)
                client.exchangeAsSession(identity, request.id, request, BoardQuestionAnswerRequest.serializer(), BoardQuestionAnswerResponse.serializer())
            }
            PushActionKind.Later -> {
                if (!payload.offersLater() || !client.state.value.supports(HarnessFeature.ATTENTION_LATER)) return PushActionResult.ReadInApp
                val read = BoardGetRequest(projectId = project)
                val board = client.exchangeAsSession(identity, read.id, read, BoardGetRequest.serializer(), BoardGetResponse.serializer()).board
                val target = BoardView(board).notificationLaterTarget(payload) ?: return PushActionResult.Stale
                if (!pushActionsUnlocked(app)) return PushActionResult.Offline
                val request = target.notificationLaterRequest(project, app.repository.settings.value.workDayStart)
                mayHaveCommitted = true
                client.exchangeAsSession(identity, request.id, request, BoardLaterSetRequest.serializer(), BoardLaterSetResponse.serializer())
            }
            PushActionKind.Reply -> {
                mayHaveCommitted = true
                val request = action.replyRequest(project)
                client.exchangeAsSession(identity, request.id, request, ConversationSubmitRequest.serializer(), ConversationSubmitResponse.serializer())
            }
            PushActionKind.MarkRead -> {
                if (chatRead) {
                    if (!client.state.value.supports(RESOLVED_PUSH_FEATURE)) return PushActionResult.Sent
                    val through = requireNotNull(payload.entryId)
                    val request = NotificationsInteractionRequest(deviceId = app.repository.settings.value.deviceId,
                        readChat = NotificationsInteractionRequestReadChat(project, payload.coordinatorId ?: MAIN_THREAD_ID, through))
                    mayHaveCommitted = true
                    client.exchangeAsSession(identity, request.id, request, NotificationsInteractionRequest.serializer(), NotificationsInteractionResponse.serializer())
                } else {
                    val request = AnswersUpdateRequest(projectId = project, answerId = requireNotNull(payload.answerId), read = true)
                    mayHaveCommitted = true
                    client.exchangeAsSession(identity, request.id, request, AnswersUpdateRequest.serializer(), AnswersUpdateResponse.serializer())
                }
            }
        }
        return PushActionResult.Sent
    } catch (error: CancellationException) { throw error }
    catch (error: ClientException) {
        return when {
            error.code in authenticationErrors -> PushActionResult.SignedOut
            action.kind == PushActionKind.Answer && error.code in setOf("board_conflict", "unknown_task", "unknown_project") -> PushActionResult.Stale
            action.kind == PushActionKind.Later && error.code in setOf("board_conflict", "not_found", "bad_request") -> PushActionResult.Stale
            error.code == "not_ready" -> PushActionResult.Offline
            error.code in uncertainErrors -> if (mayHaveCommitted) PushActionResult.Unconfirmed else PushActionResult.Offline
            else -> PushActionResult.Rejected
        }
    } catch (_: Exception) {
        return if (mayHaveCommitted) PushActionResult.Unconfirmed else PushActionResult.Offline
    }
}

internal fun PendingPushAction.answerRequest(projectId: String): BoardQuestionAnswerRequest {
    val question = requireNotNull(payload.question)
    return BoardQuestionAnswerRequest(projectId = projectId, questionId = question.id, expectedRevision = question.revision, answer = requireNotNull(text))
}

internal fun PendingPushAction.replyRequest(projectId: String) = ConversationSubmitRequest(
    projectId = projectId, threadId = payload.coordinatorId?.takeUnless { it == MAIN_THREAD_ID }, requestId = id,
    content = JsonPrimitive(requireNotNull(text)), whenBusy = "followUp", keepDraft = true)
