package io.github.mitzacoder.kemiri.features.chat

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.settings.OFFICIAL_AGENT_LABEL
import io.github.mitzacoder.kemiri.features.settings.isWorkerOnly
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

internal data class ProjectWorkerModelRow(val order: Int, val name: String, val provider: String, val role: String, val thinking: String?, val officialAgent: Boolean = false)

/** Same availability rule as the server: catalog membership, not credential status. */
internal fun projectWorkerModelRows(projectModels: List<WorkerModel>, catalog: List<ModelInfo>, thinkingOverride: String?): List<ProjectWorkerModelRow> {
    var foundDefault = false
    return projectModels.mapIndexed { index, ref ->
        val model = catalog.find { it.provider == ref.provider && it.modelId == ref.modelId }
        val role = if(model == null) "Unavailable" else if(foundDefault) "Fallback" else "Default"
        if(model != null) foundDefault = true
        ProjectWorkerModelRow(index + 1,model?.name ?: ref.modelId,ref.provider,role,thinkingOverride ?: ref.thinkingLevel,model?.let(::isWorkerOnly) == true)
    }
}

@Composable internal fun ProjectWorkerModels(models: List<WorkerModel>, catalog: List<ModelInfo>, thinking: String?, pickedModel: ModelRef?, onSettings: () -> Unit) {
    Surface(shape = MaterialTheme.shapes.medium,color = Jarvis.colors.surface2) {
        Column(Modifier.fillMaxWidth().padding(12.dp),verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(),horizontalArrangement = Arrangement.SpaceBetween,verticalAlignment = Alignment.CenterVertically) {
                Text("Project worker models",style = MaterialTheme.typography.labelLarge,fontWeight = FontWeight.SemiBold,modifier = Modifier.weight(1f))
                TextButton(onClick = onSettings,contentPadding = PaddingValues(horizontal = 8.dp),modifier = Modifier.heightIn(min = 48.dp)) { Text("Change") }
            }
            Text("From project settings · tried in order",style = MaterialTheme.typography.labelSmall,color = Jarvis.colors.fgSubtle)
            val rows = projectWorkerModelRows(models,catalog,thinking)
            rows.forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("${row.order}.",style = MaterialTheme.typography.bodySmall,color = Jarvis.colors.fgSubtle)
                    Column(Modifier.weight(1f)) {
                        Text(row.name,style = MaterialTheme.typography.bodySmall,fontWeight = FontWeight.Medium)
                        Text("${row.provider} · ${thinkingLabel(row.thinking)}${if(row.officialAgent) " · $OFFICIAL_AGENT_LABEL" else ""}",style = MaterialTheme.typography.labelSmall,color = Jarvis.colors.fgSubtle)
                    }
                    Text(row.role,style = MaterialTheme.typography.labelSmall,color = Jarvis.colors.fgSubtle)
                }
            }
            if(rows.isEmpty()) Text("None set. No backend fallback; choose a worker model to start workers.",style = MaterialTheme.typography.bodySmall)
            Text((if(pickedModel != null) "Your composer pick overrides this list. " else "") +
                (if(thinking != null) "Thinking comes from your composer pick. " else "") + "The coordinator can name another model.",
                style = MaterialTheme.typography.labelSmall,color = Jarvis.colors.fgSubtle)
        }
    }
}
