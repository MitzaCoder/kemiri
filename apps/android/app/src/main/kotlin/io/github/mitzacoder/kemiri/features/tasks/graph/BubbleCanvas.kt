package io.github.mitzacoder.kemiri.features.tasks.graph

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.*
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.*
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.TaskGraph as BubbleGraph
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.GraphCamera as BubbleCamera
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.components.AgentMotion
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.*

internal class BubbleCanvasState(camera: BubbleCamera?) {
    var camera by mutableStateOf(camera)
    var positions: Map<String, GraphPosition> = emptyMap()
    var foldPosition: GraphPosition? = null
}

/** Geometry is solved from All, off the UI thread. Visibility never changes the solve or framing. */
@Composable
internal fun BubbleCanvas(state: BubbleCanvasState, graph: BubbleGraph, shown: BubbleGraph, folds: List<GraphFold>, mode: GraphMode,
    expanded: Set<GraphFoldKind>, onFold: (GraphFoldKind) -> Unit, focused: String?, allLinks: Boolean, legend: Boolean, motion: Boolean,
    motionBatch: BubbleMotionBatch, tasks: List<BoardTask>, questions: List<BoardQuestion>, onNode: (GraphNode) -> Unit, onResting: () -> Unit, modifier: Modifier = Modifier) {
    val colors = Jarvis.colors
    val density = LocalDensity.current
    val paint = remember { BubblePaint() }
    BoxWithConstraints(modifier.fillMaxSize().background(colors.bg).clipToBounds().semantics { isTraversalGroup = true }) {
        val width = maxWidth.value.toDouble(); val height = maxHeight.value.toDouble()
        val placement by produceState(BubblePlacement(state.positions), graph) {
            val previous = state.positions
            val next = withContext(Dispatchers.Default) { settledGraphPositions(graph, previous, width / max(1.0, height)) }
            state.positions = next
            if (folds.isNotEmpty()) state.foldPosition = graphFoldPosition(next, state.foldPosition)
            value = BubblePlacement(next, previous)
        }
        val positions = placement.positions
        val handoff = remember { Animatable(1f) }
        val departures = remember { mutableStateMapOf<String, BubbleDeparture>() }
        val arrivals = remember { mutableStateMapOf<String, Animatable<Float, AnimationVector1D>>() }
        val reports = remember { mutableStateMapOf<String, BubbleReport>() }
        val scope = rememberCoroutineScope()
        val framing = remember(positions) { positions + listOfNotNull(state.foldPosition?.let { "folds" to it }).toMap() }
        val fittedCamera = remember(framing, width, height) { fitGraphCamera(framing, width, height) }
        LaunchedEffect(positions) { if (state.camera == null && positions.isNotEmpty()) state.camera = fittedCamera }
        val zoom by remember(state, fittedCamera) { derivedStateOf { (state.camera ?: fittedCamera).zoom } }
        val animate = motion && zoom >= .5
        LaunchedEffect(placement) {
            handoff.snapTo(if (animate && placement.from.any { (id, p) -> !id.startsWith("task:") && positions[id]?.parentId != p.parentId }) 0f else 1f)
            if (handoff.value < 1f) handoff.animateTo(1f, tween(crewHandoffMs.toInt(), easing = LinearEasing))
        }
        LaunchedEffect(animate) { if (!animate) handoff.snapTo(1f) }
        var consumedSerial by remember { mutableLongStateOf(-1L) }
        LaunchedEffect(motionBatch, animate) {
            if (!animate || motionBatch.reset) {
                departures.clear(); arrivals.clear(); reports.clear()
            }
            if (motionBatch.serial <= consumedSerial) return@LaunchedEffect
            consumedSerial = motionBatch.serial
            if (!animate || motionBatch.reset) return@LaunchedEffect
            motionBatch.departures.forEach { node ->
                val p = positions[node.id] ?: placement.from[node.id] ?: return@forEach
                val departure = BubbleDeparture(node, p.copy())
                departures[node.id] = departure
                scope.launch {
                    departure.progress.animateTo(1f, tween(if (node.status == "stopped") 400 else crewFinishMs.toInt(), easing = LinearEasing))
                    if (departures[node.id] === departure) departures.remove(node.id)
                }
            }
            motionBatch.arrivals.forEach { id ->
                val alpha = Animatable(0f); arrivals[id] = alpha
                scope.launch {
                    alpha.animateTo(1f, tween(300))
                    if (arrivals[id] === alpha) arrivals.remove(id)
                }
            }
            motionBatch.reports.forEach { cue ->
                // A hidden report is consumed, never queued for a later View/Resting change.
                if (shown.nodes.none { it.id == cue.workerId } || shown.nodes.none { it.id == cue.taskId }) return@forEach
                val from = positions[cue.workerId] ?: return@forEach
                val to = positions[cue.taskId] ?: return@forEach
                val report = BubbleReport(cue, from.copy(), to.copy()); reports[cue.id] = report
                scope.launch {
                    report.progress.animateTo(1f, tween(1150, easing = LinearEasing))
                    reports.remove(cue.id)
                }
            }
        }
        val labels = remember(graph, positions, zoom) { placeGraphLabels(graph, positions, BubbleCamera(zoom = zoom)) }
        val edges = remember(shown, focused, allLinks) { visibleGraphEdges(shown, focused, allLinks) }
        val highlighted = remember(shown, focused) { graphNeighborhood(shown, focused) }
        val crew = remember(shown, tasks, questions) { shown.nodes.filter { it.kind != "task" }.associate { it.id to graphCrewMotion(it, tasks, questions) } }
        val looping by remember(crew, positions, fittedCamera, motion) { derivedStateOf {
            val camera = state.camera ?: fittedCamera
            graphLoopingWorkers(crew.map { (id, pose) -> GraphMotionCandidate(id, pose, graphCrewInView(positions[id], camera, width, height)) }, camera.zoom.toFloat(), motion)
        } }
        val mounted by remember(shown, positions, width, height, fittedCamera) { derivedStateOf {
            shown.nodes.filter { graphCrewInView(positions[it.id], state.camera ?: fittedCamera, width + 180, height + 180) }.map { it.id }.toSet()
        } }
        // Captions and 48dp targets have screen-space size even far below 1× zoom.
        val margin = max(200.0, 200 / zoom)
        val worldLeft = (framing.values.minOfOrNull { it.x - it.radius } ?: 0.0) - margin
        val worldTop = (framing.values.minOfOrNull { it.y - it.radius } ?: 0.0) - margin
        val worldWidth = (framing.values.maxOfOrNull { it.x + it.radius } ?: 0.0) - worldLeft + margin
        val worldHeight = (framing.values.maxOfOrNull { it.y + it.radius } ?: 0.0) - worldTop + margin
        fun Modifier.atWorld(x: Double, y: Double, dx: Double = 0.0, dy: Double = 0.0) = offset {
            IntOffset((((x - worldLeft) * zoom + dx) * density.density).roundToInt(),
                (((y - worldTop) * zoom + dy) * density.density).roundToInt())
        }
        fun changeZoom(factor: Double) { state.camera = zoomGraphCamera(state.camera ?: fittedCamera, factor) }
        Box(Modifier.fillMaxSize().pointerInput(width, height) {
            detectTransformGestures { _, pan, factor, _ ->
                val current = state.camera ?: fittedCamera
                state.camera = zoomGraphCamera(panGraphCamera(current, pan.x / density.density.toDouble(), pan.y / density.density.toDouble()), factor.toDouble())
            }
        }) {
            val tones = graph.nodes.filter { it.task != null }.associate { it.id to colors.taskStatus(taskStateTone(it.task!!)) }
            val progress = remember(graph) { graph.nodes.mapNotNull { node -> node.task?.let { node.id to taskPartProgress(it) } }.toMap() }
            // Retain the world's draw commands. Camera gestures update its render layer, not 80 circles.
            Canvas(Modifier.fillMaxSize().graphicsLayer {
                val camera = state.camera ?: fittedCamera
                transformOrigin = TransformOrigin(0f, 0f)
                scaleX = camera.zoom.toFloat(); scaleY = camera.zoom.toFloat()
                translationX = ((width / 2 - camera.x * camera.zoom) * density.density).toFloat()
                translationY = ((height / 2 - camera.y * camera.zoom) * density.density).toFloat()
            }) {
                scale(density.density, density.density, Offset.Zero) {
                    shown.nodes.filter { it.kind == "task" && it.radius > 35 && it.parent == null }.forEach { node ->
                        positions[node.id]?.let { p ->
                            val blob = Path().apply {
                                moveTo(-190f, -35f); cubicTo(-220f, -190f, -45f, -215f, 30f, -190f)
                                cubicTo(210f, -225f, 245f, -40f, 185f, 60f); cubicTo(190f, 215f, -20f, 230f, -90f, 165f)
                                cubicTo(-210f, 165f, -245f, 60f, -190f, -35f); close()
                            }
                            translate(p.x.toFloat(), p.y.toFloat()) { scale(1.15f, 1.15f, Offset.Zero) {
                                val alpha = if (node.id in highlighted) 1f else .15f
                                drawPath(blob, colors.fgSubtle.copy(alpha = .05f * alpha))
                                drawPath(blob, colors.fgSubtle.copy(alpha = .14f * alpha), style = Stroke(1f))
                            } }
                        }
                    }
                    edges.forEach { edge ->
                        val a = positions[edge.from]; val b = positions[edge.to]
                        if (a != null && b != null) {
                            val segment = graphEdgeSegment(a, b)
                            val from = Offset(segment.x1.toFloat(), segment.y1.toFloat()); val to = Offset(segment.x2.toFloat(), segment.y2.toFloat())
                            val focused = focused == edge.from || focused == edge.to
                            val ink = when { edge.kind == "blockedBy" && focused -> colors.danger; edge.kind == "parent" -> colors.taskStatus(io.github.mitzacoder.kemiri.ui.theme.TaskStatusTone.Working); edge.kind == "related" -> colors.taskStatus(io.github.mitzacoder.kemiri.ui.theme.TaskStatusTone.Review); else -> colors.fgSubtle }
                            val alpha = if (edge.from !in highlighted || edge.to !in highlighted) .08f else if (focused) .85f else .45f
                            val dash = when (edge.kind) { "blockedBy" -> floatArrayOf(5f, 5f); "foundWhile" -> floatArrayOf(2f, 6f); "related" -> floatArrayOf(8f, 6f); else -> null }
                            if (!(edge.kind == "blockedBy" && focused && animate))
                                drawLine(ink.copy(alpha = alpha), from, to, if (edge.kind == "parent") 2f else 1.8f, pathEffect = dash?.let { PathEffect.dashPathEffect(it) })
                            if (edge.kind == "blockedBy") {
                                val angle = atan2(to.y - from.y, to.x - from.x)
                                val arrow = Path().apply { moveTo(to.x, to.y); lineTo(to.x - 10 * cos(angle - .45f), to.y - 10 * sin(angle - .45f)); lineTo(to.x - 10 * cos(angle + .45f), to.y - 10 * sin(angle + .45f)); close() }
                                drawPath(arrow, ink.copy(alpha = alpha))
                            }
                        }
                    }
                    shown.nodes.filter { it.kind == "task" }.forEach { node -> positions[node.id]?.let { p ->
                        val center = Offset(p.x.toFloat(), p.y.toFloat()); val radius = node.radius.toFloat()
                        val tone = tones.getValue(node.id)
                        val alpha = (if (node.id in highlighted) 1f else .15f) * (if (node.status in listOf("done", "dropped")) .35f else 1f)
                        if (node.attention) {
                            drawCircle(tone.copy(alpha = .04f * alpha), radius + 12, center)
                            drawCircle(tone.copy(alpha = .4f * alpha), radius + 12, center, style = Stroke(2f))
                        }
                        drawCircle(lerp(colors.bg, tone, .23f).copy(alpha = alpha), radius, center)
                        drawCircle(tone.copy(alpha = alpha), radius, center, style = Stroke(if (focused == node.id) 3f else 2f))
                        drawCircle(Brush.radialGradient(listOf(Color.White.copy(alpha = .35f * alpha), Color.Transparent), center - Offset(radius * .4f, radius * .5f), radius * 1.8f), radius - 2, center)
                        translate(center.x, center.y) { with(paint) { glyph(node, tone.copy(alpha = alpha)) } }
                        val parts = progress[node.id]
                        val ring = radius + 5
                        val ringOrigin = center - Offset(ring, ring)
                        val ringSize = Size(ring * 2, ring * 2)
                        if (parts != null || (node.task!!.subtaskCount?.total ?: 0) > 0) {
                            drawCircle(colors.border.copy(alpha = alpha), ring, center, style = Stroke(3f))
                            var angle = -90f
                            if (parts != null) {
                                val total = parts.segments.sumOf { it.count }.toFloat()
                                parts.segments.forEach { part ->
                                    val sweep = part.count / total * 360
                                    val ink = when (part.tone) { PartTone.Done -> colors.success; PartTone.Working -> colors.taskStatus(io.github.mitzacoder.kemiri.ui.theme.TaskStatusTone.Working); PartTone.NeedsYou -> colors.taskStatus(io.github.mitzacoder.kemiri.ui.theme.TaskStatusTone.Review); PartTone.Other -> colors.fgSubtle }
                                    drawArc(ink.copy(alpha = alpha), angle, max(1.08f, sweep - 5.4f), false, ringOrigin, ringSize, style = Stroke(3f, cap = StrokeCap.Round))
                                    angle += sweep
                                }
                            } else node.task?.subtaskCount?.let { count ->
                                drawArc(colors.success.copy(alpha = alpha), -90f, count.done.toFloat() / count.total * 360, false, ringOrigin, ringSize, style = Stroke(3f))
                            }
                        }
                    } }
                    shown.nodes.filter { it.kind == "task" }.forEach { node -> positions[node.id]?.let { p ->
                        with(paint) { caption(node, p, labels[node.id], zoom, density.fontScale, colors.accent2, colors.accent2, colors.fg, colors.bg,
                            if (node.id in highlighted) 1f else .15f) }
                    } }
                }
            }
            val marching = edges.filter { it.kind == "blockedBy" && (focused == it.from || focused == it.to) }
            if (animate && marching.isNotEmpty()) {
                BubbleBlockerMotion(marching, positions, colors.danger.copy(alpha = .85f), Modifier.fillMaxSize().graphicsLayer {
                    val camera = state.camera ?: fittedCamera
                    transformOrigin = TransformOrigin(0f, 0f); scaleX = camera.zoom.toFloat(); scaleY = camera.zoom.toFloat()
                    translationX = ((width / 2 - camera.x * camera.zoom) * density.density).toFloat()
                    translationY = ((height / 2 - camera.y * camera.zoom) * density.density).toFloat()
                })
            }
            // Move the semantic/composable world as one layer too: pan never lays out 80 captions.
            Box(Modifier.wrapContentSize(Alignment.TopStart, unbounded = true)
                .requiredSize((worldWidth * zoom).dp, (worldHeight * zoom).dp).graphicsLayer {
                    val camera = state.camera ?: fittedCamera
                    translationX = ((width / 2 + (worldLeft - camera.x) * camera.zoom) * density.density).toFloat()
                    translationY = ((height / 2 + (worldTop - camera.y) * camera.zoom) * density.density).toFloat()
                }) {
            shown.nodes.forEach { node ->
                val p = positions[node.id]
                if (p != null && node.id in mounted) key(node.id) {
                    val dim = if (node.id in highlighted) 1f else .15f
                    val drawnSize = if (node.kind == "task") node.radius * 2 * zoom else (if (node.kind == "thread") 52.5 else 42.0) * zoom
                    val targetSize = max(48.0, drawnSize).toFloat()
                    Box(Modifier.atWorld(p.x, p.y, -targetSize / 2.0, -targetSize / 2.0).size(targetSize.dp)
                        .graphicsLayer {
                            if (node.kind != "task") {
                                val animated = bubbleCrewPosition(node.id, placement, handoff.value) ?: p
                                translationX = ((animated.x - p.x) * zoom * density.density).toFloat()
                                translationY = ((animated.y - p.y) * zoom * density.density).toFloat()
                                alpha = arrivals[node.id]?.value ?: 1f
                            }
                        }
                        .clickable(role = Role.Button, onClickLabel = if (node.kind == "task") "Show task" else "Show worker") { onNode(node) }
                        .semantics(mergeDescendants = true) { contentDescription = graphLabel(node); selected = node.id == focused }, contentAlignment = Alignment.Center) {
                        if (node.kind != "task") Box(Modifier.graphicsLayer {
                            val camera = state.camera ?: fittedCamera
                            scaleX = camera.zoom.toFloat(); scaleY = camera.zoom.toFloat(); alpha = dim
                        }) {
                            GraphCrewMascot(GraphCrewMember(node.id, node.status, crew.getValue(node.id), node.kind == "thread"), node.id in looping,
                                mascotSize = (if (node.kind == "thread") 52.5 else 42.0).dp, canvasManaged = true)
                        }
                    }

                }
            }
            departures.forEach { (id, departure) ->
                val node = departure.node; val p = departure.position
                if (animate && graphCrewInView(p, state.camera ?: fittedCamera, width, height)) key("depart:$id") {
                    val stopped = node.status == "stopped"
                    val size = if (node.kind == "thread") 52.5 else 42.0
                    Box(Modifier.atWorld(p.x, p.y, -size / 2, -size / 2).size(size.dp).graphicsLayer {
                        scaleX = zoom.toFloat(); scaleY = zoom.toFloat()
                        val elapsed = departure.progress.value * if (stopped) 400f else 1700f
                        alpha = (1f - (elapsed - if (stopped) 0f else 1300f) / 400f).coerceIn(0f, 1f)
                    }) {
                        GraphCrewMascot(GraphCrewMember(id, node.status, if (stopped) AgentMotion.Idle else AgentMotion.Done, node.kind == "thread"),
                            !stopped, mascotSize = size.dp, canvasManaged = true)
                    }
                }
            }
            reports.forEach { (id, report) -> key(id) {
                val from = report.from; val to = report.to
                val distance = hypot(to.x - from.x, to.y - from.y).coerceAtLeast(1.0)
                val dx = (to.x - from.x) * (1 - to.radius / distance)
                val dy = (to.y - from.y) * (1 - to.radius / distance)
                val ink = colors.taskStatus(io.github.mitzacoder.kemiri.ui.theme.TaskStatusTone.Working)
                Canvas(Modifier.atWorld(from.x, from.y, -4 * zoom, -4 * zoom).size((8 * zoom).dp).graphicsLayer {
                    val t = (report.progress.value * 1150f / 650f).coerceIn(0f, 1f)
                    val travel = CubicBezierEasing(.42f, 0f, .58f, 1f).transform(t)
                    translationX = (dx * zoom * density.density * travel).toFloat()
                    translationY = (dy * zoom * density.density * travel).toFloat()
                    scaleX = .5f + travel * .5f; scaleY = scaleX
                    alpha = min(t / .15f, (1 - t) / .15f).coerceIn(0f, 1f)
                }) { drawCircle(ink) }
                val ringSize = (to.radius + 8) * 2 * zoom
                Canvas(Modifier.atWorld(to.x, to.y, -ringSize / 2, -ringSize / 2).size(ringSize.dp).graphicsLayer {
                    val t = ((report.progress.value * 1150f - 650f) / 500f).coerceIn(0f, 1f)
                    val expansion = CubicBezierEasing(0f, 0f, .58f, 1f).transform(t)
                    scaleX = 1 + .45f * expansion; scaleY = scaleX
                    alpha = .8f * min(t / .15f, (1 - t) / .85f).coerceIn(0f, 1f)
                }) { drawCircle(ink, radius = size.minDimension / 2 - 1.dp.toPx(), style = Stroke((2 * zoom).dp.toPx())) }
            } }
            }
        }
        if (legend) Surface(Modifier.align(Alignment.TopStart).padding(12.dp), shape = RoundedCornerShape(10.dp), color = colors.surface) {
            Text("— Subtask   ┄ Blocked by →\n·· Found while   ╌ Related", color = colors.fgMuted, fontSize = 12.sp, modifier = Modifier.padding(12.dp))
        }
        // One measured column owns both rows, so font scaling cannot move controls over fold chips.
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (mode == GraphMode.Live && folds.isNotEmpty()) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                folds.forEach { fold -> OutlinedButton(onClick = { onFold(fold.kind) }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 6.dp),
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp).semantics { stateDescription = if (fold.kind in expanded) "Expanded" else "Collapsed" },
                    colors = ButtonDefaults.outlinedButtonColors(containerColor = colors.surface, contentColor = colors.fg)) {
                    Text("${fold.kind.label} · ${fold.taskIds.size} ${if (fold.kind in expanded) "▾" else "▸"}", fontSize = 14.sp)
                } }
            }
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalArrangement = Arrangement.spacedBy(8.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                if (shown.resting.isNotEmpty()) OutlinedButton(onClick = onResting, modifier = Modifier.heightIn(min = 48.dp),
                    contentPadding = PaddingValues(horizontal = 12.dp), colors = ButtonDefaults.outlinedButtonColors(containerColor = colors.surface, contentColor = colors.fg)) { Text("Resting · ${shown.resting.size}", fontSize = 12.sp) }
                else Spacer(Modifier.width(0.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    listOf("−" to "Zoom out", "+" to "Zoom in", "Fit" to "Fit graph").forEachIndexed { index, (text, label) ->
                        OutlinedButton(onClick = { when (index) { 0 -> changeZoom(.8); 1 -> changeZoom(1.25); else -> state.camera = fitGraphCamera(framing, width, height) } },
                            modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = label }, contentPadding = PaddingValues(horizontal = 8.dp),
                            shape = RoundedCornerShape(10.dp), colors = ButtonDefaults.outlinedButtonColors(containerColor = colors.surface, contentColor = colors.fg)) { Text(text, fontSize = 14.sp) }
                    }
                }
            }
        }
        if (graph.nodes.isEmpty()) Text("No active tasks. Show closed or use List.", modifier = Modifier.align(Alignment.Center).padding(16.dp), color = colors.fgMuted)
    }
}
