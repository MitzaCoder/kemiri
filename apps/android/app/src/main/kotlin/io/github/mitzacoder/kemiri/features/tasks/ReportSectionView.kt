package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.features.chat.artifactVersionAddress
import io.github.mitzacoder.kemiri.features.chat.artifactVersions
import io.github.mitzacoder.kemiri.protocol.Artifact
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

internal sealed interface ReportSectionViewEntry {
    data object Hidden : ReportSectionViewEntry
    data object Unavailable : ReportSectionViewEntry
    data class File(val label: String, val artifact: Artifact) : ReportSectionViewEntry
}

internal fun reportSectionViewEntry(
    supported: Boolean, views: JsonElement?, section: ReportSectionKind,
    projectId: String, taskId: String, artifacts: List<Artifact>,
): ReportSectionViewEntry {
    if (!supported || section !in listOf(ReportSectionKind.Results, ReportSectionKind.NotDone)) return ReportSectionViewEntry.Hidden
    val reference = (views as? JsonObject)?.get(section.wireKey) ?: return ReportSectionViewEntry.Hidden
    val view = reference as? JsonObject ?: return ReportSectionViewEntry.Unavailable
    val artifactId = (view["artifactId"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    val version = (view["version"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
    val label = (view["label"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    if (artifactId == null || !artifactId.matches(Regex("[A-Za-z0-9_-]+")) || version == null || version !in 1..9_007_199_254_740_991L ||
        label.isNullOrBlank() || label.length > 80 || label.any { it < ' ' || it in "\u007f\u2028\u2029" }) return ReportSectionViewEntry.Unavailable
    val address = "$artifactId~$version"
    val artifact = artifacts.firstOrNull { it.id == artifactId && it.projectId == projectId && it.taskId == taskId }
        ?.let(::artifactVersions)?.firstOrNull {
            it.projectId == projectId && it.taskId == taskId && it.version == version && artifactVersionAddress(it) == address &&
                it.mimeType == "text/html" && it.size in 1..256L * 1024
        } ?: return ReportSectionViewEntry.Unavailable
    return ReportSectionViewEntry.File(label, artifact.copy(id = address))
}
