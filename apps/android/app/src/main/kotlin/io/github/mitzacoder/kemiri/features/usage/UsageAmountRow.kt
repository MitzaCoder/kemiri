package io.github.mitzacoder.kemiri.features.usage

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp

@Composable
internal fun ValueNote(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
internal fun UsageAmountRow(label: String, amount: Double, modifier: Modifier = Modifier, note: String? = null, onClick: (() -> Unit)? = null) {
    Row(modifier.fillMaxWidth().then(if (onClick == null) Modifier else Modifier.clickable(role = Role.Button, onClick = onClick).heightIn(min = 48.dp)),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = if (onClick == null) Alignment.Top else Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodySmall,
                color = if (onClick == null) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.primary,
                textDecoration = if (onClick == null) null else TextDecoration.Underline)
            note?.let { ValueNote(it) }
        }
        Text(usageMoney(amount), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
    }
}
