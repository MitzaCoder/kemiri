package io.github.mitzacoder.kemiri.features.tasks.graph

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.protocol.WorkerSummary
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

internal fun graphIdleTime(worker: WorkerSummary, now: Long): String {
    val minutes = ((now - (graphTimestamp(worker.updatedAt) ?: now)).coerceAtLeast(0) / 60_000)
    val duration = if (minutes < 60) "$minutes min" else "${minutes / 60} h"
    return "${if (worker.status == "failed") "failed" else "idle"} · $duration"
}

@Composable
internal fun GraphRestingSheet(workers: List<WorkerSummary>, model: GraphModel, now: Long, onWorker: (WorkerSummary) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(16.dp)) {
        Text("Resting · ${workers.size}", style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
        Text("Idle or failed workers without an open visible task.", style = MaterialTheme.typography.bodyMedium)
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp)) {
            items(workers, key = { "${it.threadId}/${it.id}" }) { worker ->
                TextButton(onClick = { onWorker(worker) }, modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp)) {
                    val task = model.workerTask(worker)
                    val taskText = task?.let { "${it.id} · ${it.title}" } ?: worker.taskId?.let { "$it · unavailable" } ?: "No task"
                    Text("${worker.id} · ${worker.title}\n$taskText\n${graphIdleTime(worker, now)} · Open transcript",
                        color = Jarvis.colors.fg, modifier = Modifier.fillMaxWidth())
                }
            }
        }
    }
}
