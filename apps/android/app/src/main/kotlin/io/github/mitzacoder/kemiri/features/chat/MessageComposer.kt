package io.github.mitzacoder.kemiri.features.chat

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.InputTransformation
import androidx.compose.foundation.text.input.TextFieldDecorator
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.mitzacoder.kemiri.features.tasks.TaskDetailText
import io.github.mitzacoder.kemiri.ui.components.JarvisIconButton
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

/** The same message input in chat and task replies; callers own intake, drafts and sending. */
@Composable
internal fun MessageComposer(
    textState: TextFieldState,
    hint: String,
    images: List<DraftImage>,
    onRemoveImage: (String) -> Unit,
    attaching: Boolean,
    attachEnabled: Boolean,
    onAttach: () -> Unit,
    sendLabel: String,
    sendEnabled: Boolean,
    onSend: () -> Unit,
    modifier: Modifier = Modifier,
    fieldModifier: Modifier = Modifier,
    attachLabel: String = "Attach images",
    inputTransformation: InputTransformation? = null,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    showSend: Boolean = true,
    onStop: (() -> Unit)? = null,
    beforeInput: @Composable ColumnScope.() -> Unit = {},
    afterInput: @Composable ColumnScope.() -> Unit = {},
    controlsModifier: Modifier = Modifier,
    controls: @Composable RowScope.() -> Unit = {},
) {
    val fieldStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 22.sp)
    Column(modifier) {
        beforeInput()
        if (images.isNotEmpty()) ImageThumbs(images, onRemove = onRemoveImage, modifier = Modifier.padding(horizontal = 8.dp))
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.Bottom) {
            JarvisIconButton(Lucide.Paperclip, if (attaching) "Reading attachments" else attachLabel, enabled = attachEnabled, onClick = onAttach)
            BasicTextField(
                state = textState,
                inputTransformation = inputTransformation,
                lineLimits = TextFieldLineLimits.MultiLine(maxHeightInLines = 5),
                keyboardOptions = keyboardOptions,
                modifier = Modifier.weight(1f).align(Alignment.CenterVertically).padding(horizontal = 4.dp).then(fieldModifier),
                textStyle = fieldStyle.copy(color = Jarvis.colors.fg),
                cursorBrush = SolidColor(Jarvis.colors.accent2),
                decorator = TextFieldDecorator { field ->
                    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.CenterStart) {
                        if (textState.text.isEmpty()) TaskDetailText(hint, style = fieldStyle, color = Jarvis.colors.fgSubtle,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        field()
                    }
                },
            )
            if (onStop != null) JarvisIconButton(Lucide.Square, "Stop coordinator", emphasized = !showSend, onClick = onStop)
            if (showSend) JarvisIconButton(Lucide.ArrowUp, sendLabel, emphasized = true, enabled = sendEnabled, onClick = onSend)
        }
        afterInput()
        Row(controlsModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp), content = controls)
    }
}
