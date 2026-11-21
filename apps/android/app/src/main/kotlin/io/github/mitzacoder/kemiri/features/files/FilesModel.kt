package io.github.mitzacoder.kemiri.features.files

import io.github.mitzacoder.kemiri.protocol.*
import java.util.Locale

internal const val PROJECT_FILES = "project-files"
internal const val WORKING_CHANGES = "project-changes-working"

internal fun CodeRoot.rootKey(): String = when (this) {
    is CodeRootProject -> "project"
    is CodeRootWorker -> "worker:$workerId"
    is CodeRootThread -> "thread:$threadId"
    else -> kind
}
internal fun CodeRoot.label(): String = when (this) {
    is CodeRootWorker -> "Workspace · $workerId"
    is CodeRootThread -> "Thread · $threadId"
    else -> "Project folder"
}
internal data class CheckoutChoice(val root: CodeRoot, val label: String)
internal fun checkoutChoices(workers: List<WorkerSummary>, threads: List<ThreadSummary>): List<CheckoutChoice> =
    listOf(CheckoutChoice(CodeRootProject(), "Project folder")) +
        workers.filter { it.isolation == "workspace" && !it.workspacePath.isNullOrBlank() }
            .map { CheckoutChoice(CodeRootWorker(workerId = it.id), "Workspace · ${it.title.ifBlank { it.id }}") } +
        threads.filter { !it.main && !it.archived }.map { CheckoutChoice(CodeRootThread(threadId = it.id), "Thread · ${it.title.ifBlank { it.id }}") }

internal fun preferredCheckout(worker: WorkerSummary?, threadId: String?): CodeRoot = when {
    worker?.isolation == "workspace" && !worker.workspacePath.isNullOrBlank() -> CodeRootWorker(workerId = worker.id)
    !threadId.isNullOrBlank() && threadId != MAIN_THREAD_ID -> CodeRootThread(threadId = threadId)
    else -> CodeRootProject()
}
internal fun parentFolder(path: String) = path.substringBeforeLast('/', "")
internal fun checkoutBreadcrumb(path: String): List<Pair<String, String>> = buildList {
    add("Root" to "")
    var folder = ""
    for (part in path.split('/').filter(String::isNotEmpty)) {
        folder = if (folder.isEmpty()) part else "$folder/$part"
        add(part to folder)
    }
}
internal fun validCheckoutPath(path: String): Boolean = path.length in 1..4096 && path.toByteArray().size <= 4096 &&
    !Regex("^[a-zA-Z]:").containsMatchIn(path) && '\\' !in path && '\u0000' !in path &&
    path.split('/').all { it.isNotEmpty() && it.lowercase(Locale.ROOT) !in setOf(".", "..", ".git", ".jj") }
internal fun pathInCheckout(toolPath: String, checkoutPath: String?): String? {
    val path = toolPath.replace('\\', '/')
    val prefix = checkoutPath?.replace('\\', '/')?.trimEnd('/')
    val relative = if (prefix != null && path.startsWith("$prefix/")) path.removePrefix("$prefix/") else path.removePrefix("./")
    return relative.takeIf(::validCheckoutPath)
}
internal fun searchFileQuery(raw: String): String? = raw.trim().takeIf(String::isNotEmpty)?.take(256)
internal data class FileSearchRequestKey(val root: CodeRoot, val query: String)
internal fun fileSearchKey(root: CodeRoot, input: String) = searchFileQuery(input)?.let { FileSearchRequestKey(root, it) }
internal sealed interface CheckoutFile {
    data object Sensitive : CheckoutFile
    data class Binary(val mime: String) : CheckoutFile
    data class TooLarge(val bytes: Long) : CheckoutFile
    data class Text(val text: String, val hash: String) : CheckoutFile
    data object Unavailable : CheckoutFile
}
internal fun checkoutFile(result: FilesReadResponse): CheckoutFile = when {
    result.sensitive == true -> CheckoutFile.Sensitive
    result.binary == true -> CheckoutFile.Binary(result.mimeType ?: "application/octet-stream")
    result.tooLarge == true -> CheckoutFile.TooLarge(result.size)
    result.text != null && result.hash != null -> CheckoutFile.Text(result.text, result.hash)
    else -> CheckoutFile.Unavailable
}
internal fun fileBytes(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> String.format(Locale.ROOT, "%.1f MiB", bytes / (1024.0 * 1024))
    bytes >= 1024 -> String.format(Locale.ROOT, "%.1f KiB", bytes / 1024.0)
    else -> "$bytes B"
}
