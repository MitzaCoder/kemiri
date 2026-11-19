package io.github.mitzacoder.kemiri.features.settings

import android.content.Intent
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.data.BackendConfig
import io.github.mitzacoder.kemiri.features.status.StatusGlyphs
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

/** Shares addresses only. The selected computer is always included when its address is shareable. */
@Composable
internal fun AddressShareRow(computer: BackendConfig, otherComputers: List<BackendConfig>) {
    val context = LocalContext.current
    var included by rememberSaveable(computer.key) { mutableStateOf(listOf<String>()) }
    val shareable = otherComputers.filter { it.key != computer.key && isConnectUrl(it.url) }
    val chosen = listOf(computer) + shareable.filter { it.key in included }
    val canShare = isConnectUrl(computer.url)
    SettingsRow(
        "Link or QR code", hint = "Addresses only. Does not grant access or sign in.", control = RowControl.Full,
        learn = { Text("Choose the backends to pass on. The link keeps them in its fragment, so it never reaches a server log; opening it on the other device shows them, and one tap adds them there.") },
    ) {
        if (canShare) shareable.forEach { backend ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(backend.key in included, { checked -> included = if (checked) included + backend.key else included - backend.key },
                    Modifier.semantics { contentDescription = "Include ${backend.name}" })
                Column(Modifier.weight(1f)) {
                    Text("Include ${backend.name}", style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        when {
            !canShare -> Text("This computer’s address cannot be shared in a connect link. Connect links carry only HTTPS origins.",
                style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)
            chosen.size > MAX_CONNECT_BACKENDS -> Text("A link carries at most $MAX_CONNECT_BACKENDS computers. Leave some out and make a second link.",
                style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)
            else -> {
                val href = remember(chosen) { connectHref(CONNECT_APP_ORIGIN, chosen.map { BackendConfig(shareableName(it.name), it.url) }) }
                val modules = remember(href) { runCatching { qrModules(href) }.getOrNull() }
                modules?.let { QrCode(it, Modifier.align(Alignment.CenterHorizontally).semantics { contentDescription = "QR code of the connect link" }) }
                Text("Connect link", style = MaterialTheme.typography.labelMedium, color = Jarvis.colors.fgMuted)
                SelectionContainer {
                    Text(href, Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Jarvis.colors.surface2).padding(8.dp),
                        style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = {
                        val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Connect link", href))
                    }) { LucideGlyph(Lucide.Copy, size = 16.dp); Spacer(Modifier.width(6.dp)); Text("Copy link") }
                    Button(onClick = {
                        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, href).putExtra(Intent.EXTRA_SUBJECT, "Kemiri computers")
                        context.startActivity(Intent.createChooser(send, "Share connect link"))
                    }) { LucideGlyph(StatusGlyphs.Share, size = 16.dp); Spacer(Modifier.width(6.dp)); Text("Share") }
                }
                Text("Scan the code or send the link to the other device, then confirm there.", style = MaterialTheme.typography.labelSmall, color = Jarvis.colors.fgMuted)
            }
        }
    }
}

/** A QR code drawn black on white with its quiet zone, whatever the theme, so every scanner reads it. */
@Composable
internal fun QrCode(modules: List<BooleanArray>, modifier: Modifier = Modifier) {
    Canvas(modifier.size(200.dp).background(Color.White, RoundedCornerShape(8.dp))) {
        val quiet = 4
        val count = modules.size + 2 * quiet
        val cell = size.width / count
        modules.forEachIndexed { y, row ->
            row.forEachIndexed { x, dark ->
                if (dark) drawRect(Color.Black, Offset((x + quiet) * cell, (y + quiet) * cell), Size(cell + 0.5f, cell + 0.5f))
            }
        }
    }
}
