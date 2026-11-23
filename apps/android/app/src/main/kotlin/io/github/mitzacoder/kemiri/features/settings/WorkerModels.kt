package io.github.mitzacoder.kemiri.features.settings

import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.data.ProjectSetting
import io.github.mitzacoder.kemiri.data.configureProject
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.ModelRef
import io.github.mitzacoder.kemiri.protocol.ProjectSummary
import io.github.mitzacoder.kemiri.protocol.WorkerModel

/** Edits of a project's ordered default worker models (web `lib/workers.ts`). Each returns the same list when nothing changes. */
fun sameModel(left: WorkerModel, right: ModelRef) = left.provider == right.provider && left.modelId == right.modelId

fun moveWorkerModel(models: List<WorkerModel>, index: Int, delta: Int): List<WorkerModel> {
    val target = index + delta
    if (index !in models.indices || target !in models.indices || delta == 0) return models
    return models.toMutableList().also { val item = it.removeAt(index); it.add(target, item) }
}

fun removeWorkerModel(models: List<WorkerModel>, model: ModelRef): List<WorkerModel> {
    val next = models.filterNot { sameModel(it, model) }
    return if (next.size == models.size) models else next
}

fun setWorkerModelThinkingLevel(models: List<WorkerModel>, model: ModelRef, level: String?): List<WorkerModel> {
    val index = models.indexOfFirst { sameModel(it, model) }
    if (index < 0 || models[index].thinkingLevel == level) return models
    return models.toMutableList().also { it[index] = it[index].copy(thinkingLevel = level) }
}

/** What identifies a list for "has the backend's answer changed it": models in order with their levels. */
fun workerModelsSignature(models: List<WorkerModel>) = models.joinToString(",") { "${it.provider}/${it.modelId}:${it.thinkingLevel.orEmpty()}" }

/** The check-in interval a text field may hold (web `commitMinutes`): a whole number of minutes from 1 to 1440, else null. */
fun parseCheckInMinutes(text: String): Long? = text.trim().toLongOrNull()?.takeIf { it in 1L..1440L }

@Composable
internal fun OutsideModelRunLimitRow(context: ProjectScreenContext, project: ProjectSummary) {
    val save = rememberSaveState(project.id)
    SettingsRow(
        "Outside-model run limit",
        hint = "Agents may run at most this many workers or jobs at once on models outside this list. A further one asks you first. Leave empty for no limit.",
        status = save,
        control = RowControl.Auto,
    ) {
        AutoInput(
            project.outsideModelRunLimit?.toString().orEmpty(), save, Modifier.widthIn(max = 128.dp),
            placeholder = "No limit", numeric = true, label = "Outside-model run limit",
        ) { text ->
            val limit = if (text.isEmpty()) null else text.toLongOrNull()?.takeIf { it in 0L..9_007_199_254_740_991L }
                ?: throw IllegalArgumentException("Enter a whole number of 0 or more, or leave empty.")
            context.backend.client.configureProject(project.id, ProjectSetting.OutsideModelRunLimit(limit))
            context.backend.refreshProjects()
        }
    }
}
