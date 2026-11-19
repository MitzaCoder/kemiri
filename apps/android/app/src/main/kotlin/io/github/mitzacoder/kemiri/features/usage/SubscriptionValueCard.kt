package io.github.mitzacoder.kemiri.features.usage

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.protocol.SubscriptionValue
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.Role
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import java.math.BigDecimal
import java.net.URI
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun SubscriptionValueCard(
    subscription: SubscriptionValue, editable: Boolean, openTask: (String, String) -> Unit,
    projectName: (String) -> String, savePrice: suspend (Double?) -> Unit,
) {
    val price = subscription.price
    val headline = subscriptionHeadline(subscription)
    val binding = subscription.windows.firstOrNull { it.binding } ?: subscription.windows.firstOrNull()
    val fullUse = binding?.fullWindowValue?.let { window -> binding.windowsPerMonth?.let { window.estimate * it } }
    val scale = maxOf(subscription.apiValue, price.monthlyPrice ?: 0.0, fullUse ?: 0.0)
    val coordinator = subscription.coordinatorProjects.orEmpty()
    val accent = Jarvis.colors.accent2
    var editing by remember { mutableStateOf(false) }

    OutlinedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                ValueHeading(listOfNotNull(subscription.label, subscription.plan).joinToString(" · "))
                Text(headline.work, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                headline.comparison?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                    when (price.kind) {
                        "default" -> {
                            val uriHandler = LocalUriHandler.current
                            val priceSource = price.source?.takeIf { source -> runCatching { URI(source).scheme == "https" }.getOrDefault(false) }
                            TextButton(onClick = { if (priceSource != null) runCatching { uriHandler.openUri(priceSource) } },
                                enabled = priceSource != null, contentPadding = PaddingValues(horizontal = 4.dp)) {
                                Text("default price" + (price.checkedOn?.let { " · Checked $it" } ?: "") + if (priceSource != null) " · Price source" else "",
                                    style = MaterialTheme.typography.labelMedium)
                            }
                        }
                        "owner" -> ValueNote("Owner price")
                    }
                    if (editable) OutlinedButton(onClick = { editing = true }) { Text(headline.priceAction) }
                    else if (price.kind == "none") ValueNote("Add what you pay in the current month.")
                }
            }

            if (binding != null) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    price.monthlyPrice?.let { ValueBar("Monthly price", it, scale, MaterialTheme.colorScheme.onSurfaceVariant) }
                    ValueBar("API value used", subscription.apiValue, scale, accent)
                    fullUse?.let { ValueBar("At full use · estimated", it, scale, accent.copy(alpha = .35f)) }
                }
                HorizontalDivider()
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ValueFact("Plan used this month", usagePercent(subscription.planUsed), Modifier.weight(1f))
                    val fullWindow = binding.fullWindowValue
                    ValueFact(fullWindowLabel(binding), fullWindow?.let { "≈ ${usageMoney(it.estimate)}" } ?: "not enough use yet",
                        Modifier.weight(1f), fullWindow?.let(::usageRange))
                    ValueFact("Used elsewhere", usagePercent(binding.elsewhereShare), Modifier.weight(1f))
                }
                HorizontalDivider()
                if (subscription.models.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ValueHeading("Models")
                    val modelScale = subscription.models.maxOf { it.apiValue }
                    subscription.models.forEach { model ->
                        ValueBar(model.model, model.apiValue, modelScale, accent.copy(alpha = .65f))
                        ValueNote(model.valuePerPoint?.let { "≈ ${usageMoney(it.estimate)} per point · ${usageRange(it)}" }
                            ?: if (model.scopedWindowId != null) "not enough use yet" else "not measured separately")
                    }
                }
            }
            if (binding != null || coordinator.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                ValueHeading("Where it went")
                if (subscription.topTasks.isEmpty()) ValueNote("No recorded work linked to tasks this month.")
                subscription.topTasks.forEach { task ->
                    UsageAmountRow("${task.taskId} · ${task.title}", task.apiValue, onClick = { openTask(task.projectId, task.taskId) })
                }
                coordinator.forEach { project -> UsageAmountRow("Coordinator · ${projectName(project.projectId)}", project.apiValue) }
                if (subscription.topTasks.isNotEmpty() || coordinator.isNotEmpty()) {
                    ValueNote((if (subscription.topTasks.isNotEmpty()) "Top tasks include their subtasks. " else "") + "Coordinator work is not spread across tasks.")
                }
            }
        }
    }
    if (editing && editable) MonthlyPriceDialog(subscription, savePrice, dismiss = { editing = false })
}

@Composable
private fun MonthlyPriceDialog(subscription: SubscriptionValue, savePrice: suspend (Double?) -> Unit, dismiss: () -> Unit) {
    var input by remember { mutableStateOf(subscription.price.monthlyPrice?.let { BigDecimal.valueOf(it).stripTrailingZeros().toPlainString() }.orEmpty()) }
    val amount = monthlyPriceFromInput(input)
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun submit(price: Double?) {
        if (saving) return
        saving = true
        error = null
        scope.launch {
            try {
                savePrice(price)
                dismiss()
            } catch (cause: CancellationException) { throw cause }
            catch (cause: Exception) { error = cause.message ?: "Request failed" }
            finally { saving = false }
        }
    }
    AlertDialog(
        onDismissRequest = { if (!saving) dismiss() }, title = { Text(subscription.label) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(input, { input = it }, enabled = !saving, singleLine = true,
                    label = { Text("Monthly price (USD)") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                if (subscription.price.kind == "owner") TextButton(onClick = { submit(null) }, enabled = !saving) { Text("Reset to default") }
                error?.let { Text("Could not save price: $it", color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = { TextButton(onClick = { amount?.let { submit(it) } }, enabled = !saving && amount != null) { Text(if (saving) "Saving…" else "Save price") } },
        dismissButton = { TextButton(onClick = dismiss, enabled = !saving) { Text("Cancel") } },
    )
}

@Composable
internal fun ValueHeading(label: String) {
    Text(label, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleSmall)
}

@Composable
internal fun ValueNote(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun ValueFact(label: String, fact: String, modifier: Modifier, note: String? = null) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        ValueNote(label)
        Text(fact, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
        note?.let { ValueNote(it) }
    }
}

@Composable
private fun ValueBar(label: String, amount: Double, scale: Double, color: Color) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        UsageAmountRow(label, amount)
        Box(Modifier.fillMaxWidth().height(5.dp).clip(CircleShape).background(Jarvis.colors.surface2)) {
            if (scale > 0 && amount > 0) Box(Modifier.fillMaxWidth((amount / scale).toFloat().coerceIn(0f, 1f)).fillMaxHeight().clip(CircleShape).background(color))
        }
    }
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
