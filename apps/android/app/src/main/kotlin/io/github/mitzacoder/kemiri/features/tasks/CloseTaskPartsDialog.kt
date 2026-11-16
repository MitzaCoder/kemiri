package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.ProjectBoard

/** Native dismissal (including system Back) is Cancel, never an implicit close. */
@Composable
fun CloseTaskPartsDialog(board: ProjectBoard) {
    val prompt by board.closeParts.collectAsStateWithLifecycle()
    val question = prompt ?: return
    fun answer(choice: String?) { question.reply.complete(choice) }
    AlertDialog(
        onDismissRequest = { answer(null) },
        title = { Text("Close ${question.taskId}?") },
        text = { Text(question.question) },
        confirmButton = {
            Column {
                TextButton(onClick = { answer("close") }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Close them too") }
                TextButton(onClick = { answer("follow_up") }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Keep as follow-ups") }
                TextButton(onClick = { answer(null) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Cancel") }
            }
        },
    )
}
