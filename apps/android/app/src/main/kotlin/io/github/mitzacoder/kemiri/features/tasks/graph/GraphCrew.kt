package io.github.mitzacoder.kemiri.features.tasks.graph

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
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
internal fun GraphCrewMascot(member: GraphCrewMember, motion: Boolean, reporting: Boolean = false, mascotSize: Dp = 32.dp) {
    val ink = Jarvis.colors.fg
    val badgeTone = when (member.state) {
        AgentMotion.Failed -> Jarvis.colors.danger
        AgentMotion.Done -> Jarvis.colors.success
        else -> Jarvis.colors.warning
    }
    val spark = remember { Animatable(1f) }
    val opacity = remember { Animatable(if (motion && member.state != AgentMotion.Done) 0f else 1f) }
    LaunchedEffect(member.state == AgentMotion.Done, motion) {
        val done = member.state == AgentMotion.Done
        if (!motion) opacity.snapTo(if (done) 0f else 1f)
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
        if (badge != null) Box(Modifier.align(Alignment.TopEnd).size(14.dp).background(badgeTone, CircleShape), contentAlignment = Alignment.Center) {
            Text(badge, color = Jarvis.colors.bg, fontSize = 10.sp, lineHeight = 12.sp)
        }
        if (reporting && motion && spark.value < 1f) Canvas(Modifier.fillMaxSize()) {
            val p = spark.value
            drawCircle(ink.copy(alpha = 1 - p), size.minDimension * .06f, Offset(size.width * .5f, -size.height * p * .7f))
            if (p > .5f) drawCircle(ink.copy(alpha = (1 - p) * 2), size.width * (p - .5f),
                Offset(size.width * .5f, size.height), style = Stroke(1.dp.toPx()))
        }
    }
}

internal data class GraphCrewPlacement(val id: String, val taskId: String, val status: String, val point: GraphPoint,
    val state: AgentMotion = AgentMotion.Idle, val background: Boolean = false)
internal fun graphCrewPlacements(layout: GraphLayout, model: GraphModel): List<GraphCrewPlacement> {
    val seen = mutableSetOf<String>()
    return layout.cards.values.flatMap { card ->
        val d = model.details[card.id] ?: return@flatMap emptyList()
        val crew = graphTaskCrew(d).take(3)
        crew.mapIndexedNotNull { index, member ->
            if (!seen.add(member.id)) null else GraphCrewPlacement(member.id, card.id, member.status,
                GraphPoint(card.box.right - 12 - (crew.size - index) * 44, card.box.y - 36), member.state, member.background)
        }
    }
}

/** Keyed world positions animate reassignment, not camera pan/zoom. Only near-viewport crew mount. */
@Composable
internal fun GraphCrewLayer(layout: GraphLayout, model: GraphModel, camera: GraphCamera, viewport: GraphRect, reports: Map<String, Long>, motion: Boolean, now: Long) {
    val current = remember(layout, model) { graphCrewPlacements(layout, model).associateBy { it.id } }
    var previous by remember { mutableStateOf(current) }
    val retired = remember { mutableStateMapOf<String, Pair<GraphCrewPlacement, Long>>() }
    val origins = remember { mutableStateMapOf<String, Pair<GraphPoint, Long>>() }
    LaunchedEffect(current) {
        current.forEach { (id, crew) -> previous[id]?.takeIf { it.taskId != crew.taskId }?.let {
            origins[id] = it.point to (System.currentTimeMillis() + 650)
        } }
        previous.filterKeys { it !in current }.forEach { (id, crew) ->
            val status = if (crew.background) model.details.values.flatMap { it.threads }.find { "thread:${it.id}" == id }?.status
                else model.workers.find { "worker:${it.id}" == id }?.status
            // Hiding a resting worker or changing detail level is not a successful finish.
            if (graphCrewFinishes(status))
                retired[id] = crew.copy(status = "done", state = AgentMotion.Done) to (System.currentTimeMillis() + 1700)
        }
        current.keys.forEach { retired.remove(it) }
        previous = current
    }
    LaunchedEffect(now) {
        retired.keys.filter { retired.getValue(it).second <= now }.forEach { retired.remove(it) }
        origins.keys.filter { origins.getValue(it).second <= now }.forEach { origins.remove(it) }
    }
    val crew = current.values + retired.values.map { it.first }
    fun inView(member: GraphCrewPlacement) = camera.box(GraphRect(member.point.x, member.point.y, 40f, 40f)).overlaps(viewport)
    val looping = graphLoopingWorkers(crew.map { GraphMotionCandidate(it.id, it.state, inView(it)) }, camera.zoom, motion)
    crew.forEach { member ->
        val before = origins[member.id]?.first ?: previous[member.id]?.point ?: member.point
        val near = camera.box(GraphRect(member.point.x, member.point.y, 40f, 40f)).overlaps(viewport.expand(180f)) ||
            camera.box(GraphRect(before.x, before.y, 40f, 40f)).overlaps(viewport.expand(180f))
        if (near) key(member.id) {
            val travel = remember { Animatable(1f) }
            val opacity = remember { Animatable(if (motion && member.state != AgentMotion.Done) 0f else 1f) }
            val allowed = motion && camera.zoom >= .5f && (inView(member) ||
                camera.box(GraphRect(before.x, before.y, 40f, 40f)).overlaps(viewport))
            LaunchedEffect(member.point, origins[member.id]?.second, motion) {
                if (allowed && before != member.point) { travel.snapTo(0f); travel.animateTo(1f, tween(650)) }
                else travel.snapTo(1f)
            }
            val finished = member.status == "done"
            LaunchedEffect(finished, motion) {
                if (!allowed) opacity.snapTo(if (finished) 0f else 1f)
                else opacity.animateTo(if (finished) 0f else 1f, tween(if (finished) 400 else 300, delayMillis = if (finished) 1300 else 0))
            }
            val p = travel.value
            val screen = camera.point(GraphPoint(before.x + (member.point.x - before.x) * p,
                before.y + (member.point.y - before.y) * p - sin(p * Math.PI).toFloat() * 44f))
            val reporting = reports[member.id]?.let { it > now } == true
            Box(Modifier.offset(screen.x.dp, screen.y.dp).alpha(opacity.value)) {
                val animate = if (member.state in listOf(AgentMotion.Failed, AgentMotion.Done)) allowed else member.id in looping
                GraphCrewMascot(GraphCrewMember(member.id, member.status, member.state, member.background), animate, reporting,
                    ((if (member.background) 40 else 32) * camera.zoom).dp)
            }
        }
    }
}

/** Keep only live successful completions for their one hop/fade; stopped and resting crew leave quietly. */
@Composable
internal fun graphCardCrew(d: GraphTask): List<GraphCrewMember> {
    val current = graphTaskCrew(d)
    var previous by remember { mutableStateOf(current) }
    val retired = remember { mutableStateMapOf<String, GraphCrewMember>() }
    LaunchedEffect(current) {
        previous.filter { old -> current.none { it.id == old.id } }.forEach { old ->
            val status = if (old.background) d.threads.find { "thread:${it.id}" == old.id }?.status
                else d.workers.find { "worker:${it.id}" == old.id }?.status
            if (graphCrewFinishes(status) && status != null)
                retired[old.id] = old.copy(status = "done", state = AgentMotion.Done)
        }
        current.forEach { retired.remove(it.id) }
        previous = current
        if (retired.isNotEmpty()) { delay(1700); retired.clear() }
    }
    return current + retired.values
}
