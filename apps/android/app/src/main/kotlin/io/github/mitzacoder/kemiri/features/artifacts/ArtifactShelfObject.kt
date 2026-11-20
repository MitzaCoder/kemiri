package io.github.mitzacoder.kemiri.features.artifacts

import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.Artifact
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

@Composable
internal fun ShelfArtifact(context: ProjectScreenContext, artifact: Artifact, open: () -> Unit, discuss: (() -> Unit)?, reducedMotion: Boolean, modifier: Modifier) {
    val shape = objectShape(artifact)
    val width = when (shape) {
        ShelfShape.Phone -> 104.dp
        ShelfShape.Screen, ShelfShape.Recording, ShelfShape.Picture -> 178.dp
        else -> 143.dp
    }
    val colors = Jarvis.colors
    val frame = RoundedCornerShape(if (shape == ShelfShape.Phone) 14.dp else 7.dp)
    val count = artifact.versionCount ?: 1
    Column(modifier.width(width)) {
        Column(Modifier.fillMaxWidth().clickable(onClickLabel = "Open ${artifactTitle(artifact)}", onClick = open)) {
            Box(Modifier.fillMaxWidth().height(130.dp).padding(horizontal = 5.dp), contentAlignment = Alignment.BottomCenter) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    val height = when (shape) {
                        ShelfShape.Phone, ShelfShape.Paper -> 119.dp
                        ShelfShape.Screen, ShelfShape.Recording, ShelfShape.Picture -> 91.dp
                        else -> 98.dp
                    }
                    Box(Modifier.fillMaxWidth().height(height).padding(horizontal = if (shape == ShelfShape.Phone) 10.dp else 0.dp)) {
                        if (count > 1) {
                            Box(Modifier.matchParentSize().offset(x = 4.dp, y = (-5).dp).background(colors.surface2, frame).border(1.dp, colors.border, frame))
                            Box(Modifier.matchParentSize().offset(x = 2.dp, y = (-2).dp).background(colors.surface2, frame).border(1.dp, colors.border, frame))
                        }
                        val livingFrame = if (artifact.living != null) Modifier.livingRing(reducedMotion, if (shape == ShelfShape.Phone) 14f else 7f) else Modifier
                        val paper = if (colors.dark) Color(0xff252836) else Color(0xfffcfaf4)
                        val background = when (shape) {
                            ShelfShape.Phone, ShelfShape.Screen -> Color(0xff202230)
                            ShelfShape.Paper -> paper
                            ShelfShape.Slip -> Color(0xff1d2030)
                            else -> colors.surface2
                        }
                        Box(Modifier.matchParentSize().then(livingFrame).clip(frame).background(background)
                            .border(1.dp, colors.border.copy(alpha = .65f), frame)
                            .padding(if (shape == ShelfShape.Phone || shape == ShelfShape.Screen) 5.dp else 3.dp), contentAlignment = Alignment.Center) {
                            when {
                                shape == ShelfShape.Paper && isHtmlArtifact(artifact.name, artifact.mimeType) -> ArtifactPageThumb(context, artifact, onOpen = open)
                                shape == ShelfShape.Paper || shape == ShelfShape.Slip -> Column(Modifier.fillMaxSize().padding(8.dp), verticalArrangement = Arrangement.Center) {
                                    Text(if (shape == ShelfShape.Slip) artifact.name else artifactTitle(artifact),
                                        color = if (shape == ShelfShape.Slip) Color(0xffcbd1f2) else colors.fg,
                                        fontFamily = if (shape == ShelfShape.Slip) FontFamily.Monospace else FontFamily.Default,
                                        style = MaterialTheme.typography.labelSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                    repeat(3) { line -> Spacer(Modifier.height(5.dp)); Box(Modifier.fillMaxWidth(1f - line * .19f).height(2.dp)
                                        .background(if (shape == ShelfShape.Slip) Color(0xff596283) else colors.border, RoundedCornerShape(1.dp))) }
                                }
                                else -> ArtifactThumb(context, artifact, Modifier.fillMaxSize().clip(RoundedCornerShape(4.dp)), duration = false)
                            }
                        }
                    }
                    if (shape == ShelfShape.Screen) {
                        Box(Modifier.width(14.dp).height(9.dp).background(colors.fgSubtle))
                        Box(Modifier.width(47.dp).height(4.dp).background(colors.fgSubtle, RoundedCornerShape(4.dp)))
                    }
                }
            }
            Box(Modifier.fillMaxWidth().height(7.dp).background(Brush.verticalGradient(listOf(colors.border, colors.surface2, Color.Transparent))))
            Column(Modifier.padding(horizontal = 4.dp, vertical = 3.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(artifactTitle(artifact), style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text("${libraryKindLabel(libraryKind(artifact))} · v${artifact.version ?: 1} · ${libraryDate(artifact.createdAt)}", color = colors.fgMuted, style = MaterialTheme.typography.labelSmall)
                if (count > 1) Text("$count versions", color = colors.fgMuted, style = MaterialTheme.typography.labelSmall)
                if (artifact.living != null) Text("● Living", color = colors.accent2, style = MaterialTheme.typography.labelMedium)
            }
        }
        discuss?.let { TextButton(onClick = it) { Text("Discuss") } }
    }
}

@Composable
private fun Modifier.livingRing(reducedMotion: Boolean, corner: Float): Modifier {
    val rotation = if (reducedMotion) null else rememberInfiniteTransition(label = "Living ring").animateFloat(0f, 360f,
        infiniteRepeatable(tween(5500, easing = LinearEasing)), label = "Living ring angle")
    return drawWithContent {
        drawContent()
        val angle = rotation?.value ?: 0f
        val brush = Brush.sweepGradient(listOf(Color(0xff48cbd9), Color(0xff9484f2), Color(0xfff29e73), Color(0xff48cbd9)), center)
        val edge = 2.dp.toPx()
        val radius = corner.dp.toPx()
        if (size.minDimension > 2 * edge) {
            val ring = Path().apply {
                fillType = PathFillType.EvenOdd
                addRoundRect(RoundRect(0f, 0f, size.width, size.height, CornerRadius(radius)))
                addRoundRect(RoundRect(edge, edge, size.width - edge, size.height - edge, CornerRadius(radius - edge)))
            }
            clipPath(ring) { rotate(angle) { drawCircle(brush, radius = size.maxDimension) } }
        }
    }
}
