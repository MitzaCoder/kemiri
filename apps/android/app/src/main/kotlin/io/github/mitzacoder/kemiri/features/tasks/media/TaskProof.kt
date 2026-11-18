package io.github.mitzacoder.kemiri.features.tasks.media

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.chat.ArtifactThumb
import io.github.mitzacoder.kemiri.features.chat.ChatArtifactMetadata
import io.github.mitzacoder.kemiri.features.chat.artifactTitle
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.Artifact
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

@Composable
internal fun TaskProof(context: ProjectScreenContext, artifacts: List<Artifact>) {
    val proof = remember(artifacts) { splitMedia(artifacts).media.take(3) }
    if (proof.isEmpty()) return
    val shape = RoundedCornerShape(8.dp)
    Row(Modifier.widthIn(max = 480.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        proof.forEach { artifact -> key(artifact.id) {
            Box(Modifier.weight(1f).heightIn(min = 48.dp).aspectRatio(8f / 5).clip(shape)
                .border(1.dp, Jarvis.colors.borderStrong, shape)
                .clickable(role = Role.Button, onClickLabel = "Open proof") {
                    ChatArtifactMetadata.keep(context.backend.config.key, artifact)
                    context.navigate(Destination.Artifact(context.route, artifact.id))
                }.semantics { contentDescription = artifactTitle(artifact) }) {
                ArtifactThumb(context, artifact, Modifier.fillMaxSize())
            }
        } }
        repeat(3 - proof.size) { Spacer(Modifier.weight(1f)) }
    }
}
