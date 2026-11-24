package io.github.mitzacoder.kemiri.features.tasks.media

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.features.tasks.PartProofOrigin
import io.github.mitzacoder.kemiri.features.tasks.TaskDetailText
import io.github.mitzacoder.kemiri.features.tasks.TaskType
import io.github.mitzacoder.kemiri.features.tasks.relativeTime
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.Artifact
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

/**
 * Task Files: page previews first, then the image/video carousel and ordinary file rows. Every page opens the
 * existing artifact reader. The page group is initially bounded to four cards.
 * [onUpdateTags] is given only when the backend can change tags (`artifact-tags`).
 */
@Composable
internal fun TaskFiles(
    context: ProjectScreenContext,
    artifacts: List<Artifact>,
    onUpdateTags: (suspend (Artifact, List<String>) -> Artifact?)?,
    modifier: Modifier = Modifier,
    proofPartOrigins: Map<String, PartProofOrigin> = emptyMap(),
) {
    val split = remember(artifacts) { splitMedia(artifacts) }
    fun open(artifact: Artifact) {
        ChatArtifactMetadata.keep(context.backend.config.key, artifact)
        context.navigate(Destination.Artifact(context.route, artifact.id))
    }
    var pagesExpanded by rememberSaveable { mutableStateOf(false) }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        val pages = split.files.filter { isHtmlArtifact(it.name, it.mimeType) }
        pages.take(if (pagesExpanded) pages.size else 4).forEach { page ->
            Column(Modifier.fillMaxWidth().clickable(onClickLabel = "Open ${artifactTitle(page)}") { open(page) }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                TaskDetailText(artifactTitle(page), style = TaskType.sectionTitle, color = Jarvis.colors.fg)
                Text(listOfNotNull("Page", proofPartOrigins[page.id]?.title).joinToString(" · "), style = TaskType.meta, color = Jarvis.colors.accent2)
                ArtifactPageThumb(context, page, onOpen = { open(page) })
            }
        }
        if (pages.size > 4) OutlinedButton(onClick = { pagesExpanded = !pagesExpanded }) { Text(if (pagesExpanded) "Fewer pages" else "Show all ${pages.size} pages") }
        if (split.media.isNotEmpty()) MediaGalleryView(context, split.media, onUpdateTags, onDetails = ::open, proofPartOrigins = proofPartOrigins)
        if (split.files.isNotEmpty()) FileRows(split.files.filterNot { isHtmlArtifact(it.name, it.mimeType) }, onOpen = ::open, proofPartOrigins = proofPartOrigins)
    }
}

/** The other files, newest first: four, then all on request. */
@Composable
private fun FileRows(files: List<Artifact>, onOpen: (Artifact) -> Unit, proofPartOrigins: Map<String, PartProofOrigin>) {
    val colors = Jarvis.colors
    var expanded by rememberSaveable { mutableStateOf(false) }
    val limit = 4
    val shown = if (expanded) files else files.take(limit)
    val now = remember(files) { System.currentTimeMillis() }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        shown.forEach { file ->
            val shape = RoundedCornerShape(10.dp)
            Row(
                Modifier.fillMaxWidth().clip(shape).border(1.dp, colors.border.copy(alpha = .7f), shape)
                    .clickable(onClickLabel = "Open ${artifactTitle(file)}") { onOpen(file) }
                    .heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                LucideGlyph(artifactKindIcon(file.kind), size = 18.dp, tint = artifactKindColor(file.kind))
                Column(Modifier.weight(1f)) {
                    TaskDetailText(artifactTitle(file), style = TaskType.sectionTitle, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        listOfNotNull(proofPartOrigins[file.id]?.title, artifactKindLabel(file.kind), artifactDetailSize(file.size).orEmpty(), artifactVersionCount(file), file.createdAt.takeIf { it.isNotBlank() }?.let { relativeTime(it, now) }.orEmpty())
                            .filter { it.isNotEmpty() }.joinToString(" · "),
                        style = TaskType.meta, color = colors.fgSubtle, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        if (files.size > limit) OutlinedButton(onClick = { expanded = !expanded }, contentPadding = PaddingValues(horizontal = 10.dp)) {
            Text(if (expanded) "Fewer files" else "Show all ${files.size} files", style = TaskType.xsMedium)
        }
    }
}
