package io.github.mitzacoder.kemiri.features.tasks.media

import io.github.mitzacoder.kemiri.features.chat.artifactVersionAddress
import io.github.mitzacoder.kemiri.features.chat.artifactVersions
import io.github.mitzacoder.kemiri.features.tasks.ReportBlock
import io.github.mitzacoder.kemiri.features.tasks.ReportSectionContent
import io.github.mitzacoder.kemiri.protocol.Artifact

/** Only a rendered proof block replaces an automatic thumbnail. Files keeps the whole inventory. */
internal fun automaticReportProof(results: ReportSectionContent, artifacts: List<Artifact>): List<Artifact> {
    val cited = (results as? ReportSectionContent.Blocks)?.blocks.orEmpty()
        .filterIsInstance<ReportBlock.Proof>().mapTo(mutableSetOf()) { it.artifactRef.artifactId }
    return splitMedia(artifacts).media.filterNot { it.id in cited }.take(3)
}

/** An unavailable pinned version must never silently open the latest file instead. */
internal fun reportProofArtifact(ref: ReportBlock.Proof.ArtifactRef, artifacts: List<Artifact>): Artifact? {
    val artifact = artifacts.find { it.id == ref.artifactId } ?: return null
    val version = ref.version ?: return artifact
    val address = "${ref.artifactId}~$version"
    return artifactVersions(artifact).find { artifactVersionAddress(it) == address }?.copy(id = address)
}
