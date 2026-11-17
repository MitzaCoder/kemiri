package io.github.mitzacoder.kemiri.features.tasks.graph

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.geometry.*
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.mitzacoder.kemiri.ui.components.AgentMascot
import io.github.mitzacoder.kemiri.ui.components.AgentMotion
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlin.math.sin
import kotlinx.coroutines.delay

@Composable
internal fun GraphCrewMascot(member: GraphCrewMember, motion: Boolean, reporting: Boolean = false, mascotSize: Dp = 32.dp, canvasManaged: Boolean = false) {
    val ink = Jarvis.colors.fg
    val badgeTone = when (member.state) {
        AgentMotion.Failed -> Jarvis.colors.danger
        AgentMotion.Done -> Jarvis.colors.success
        else -> Jarvis.colors.warning
    }
    val badgeScale = mascotSize.value / 32f
    val spark = remember { Animatable(1f) }
    val opacity = remember { Animatable(if (motion && member.state != AgentMotion.Done) 0f else 1f) }
    LaunchedEffect(member.state == AgentMotion.Done, motion) {
        val done = member.state == AgentMotion.Done
        if (canvasManaged) opacity.snapTo(1f)
        else if (!motion) opacity.snapTo(if (done) 0f else 1f)
        else opacity.animateTo(if (done) 0f else 1f, tween(if (done) 400 else 300, delayMillis = if (done) 1300 else 0))
    }
    LaunchedEffect(reporting, motion) {
        if (reporting && motion) { spark.snapTo(0f); spark.animateTo(1f, tween(1400)) } else spark.snapTo(1f)
    }
    Box(Modifier.size(mascotSize).alpha(opacity.value).clearAndSetSemantics { }) {
        if (member.background) Canvas(Modifier.fillMaxSize()) {
            drawCircle(ink.copy(alpha = .65f), size.minDimension * .48f,
                style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx()))))
        }
        AgentMascot(member.state, size = mascotSize, animate = motion, phaseMs = workerMotionPhase(member.id))
        val badge = when (member.state) { AgentMotion.Waiting -> "?"; AgentMotion.Failed -> "!"; AgentMotion.Done -> "✓"; else -> null }
        if (badge != null) Box(Modifier.align(Alignment.TopEnd).size((14 * badgeScale).dp).background(badgeTone, CircleShape), contentAlignment = Alignment.Center) {
            Text(badge, color = Jarvis.colors.bg, fontSize = (10 * badgeScale).sp, lineHeight = (12 * badgeScale).sp)
        }
        if (reporting && motion && spark.value < 1f) Canvas(Modifier.fillMaxSize()) {
            val p = spark.value
            drawCircle(ink.copy(alpha = 1 - p), size.minDimension * .06f, Offset(size.width * .5f, -size.height * p * .7f))
            if (p > .5f) drawCircle(ink.copy(alpha = (1 - p) * 2), size.width * (p - .5f),
                Offset(size.width * .5f, size.height), style = Stroke(1.dp.toPx()))
        }
    }
}
