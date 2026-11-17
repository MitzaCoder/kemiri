package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.data.DeviceSettings
import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.*
import io.github.mitzacoder.kemiri.features.tasks.graph.GraphMode
import io.github.mitzacoder.kemiri.features.tasks.graph.GraphFoldKind
import io.github.mitzacoder.kemiri.features.tasks.graph.GraphFold
import io.github.mitzacoder.kemiri.features.tasks.graph.revealGraphTask
import io.github.mitzacoder.kemiri.features.tasks.graph.workerMotion
import io.github.mitzacoder.kemiri.features.tasks.graph.workerMotionPhase
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** The same inputs run through Kotlin and the web oracle. Only geometry gets a half-unit tolerance. */
class BubbleGraphTest {
    private val vector by lazy {
        val file = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .map { File(it, "apps/android/test-vectors/task-graph-bubble-v1.json") }.first { it.isFile }
        wireJson.parseToJsonElement(file.readText()).jsonObject
    }
    private fun JsonObject.text(key: String) = getValue(key).jsonPrimitive.content
    private fun JsonObject.number(key: String) = getValue(key).jsonPrimitive.double
    private fun JsonObject.flag(key: String) = getValue(key).jsonPrimitive.boolean
    private fun JsonObject.nullableText(key: String) = getValue(key).jsonPrimitive.contentOrNull
    private inline fun <reified T> JsonObject.decode(key: String): T = wireJson.decodeFromJsonElement(getValue(key))
    private fun obj(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(pairs.associate { it.first to json(it.second) })
    private fun json(value: Any?): JsonElement = when (value) {
        null -> JsonNull
        is JsonElement -> value
        is String -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        is Number -> JsonPrimitive(value)
        is Map<*, *> -> JsonObject(value.entries.associate { it.key.toString() to json(it.value) })
        is Iterable<*> -> JsonArray(value.map(::json))
        is GraphPosition -> obj("x" to value.x, "y" to value.y, "anchorX" to value.anchorX, "anchorY" to value.anchorY, "vx" to value.vx, "vy" to value.vy, "radius" to value.radius, "parentId" to value.parentId)
        is GraphCamera -> obj("x" to value.x, "y" to value.y, "zoom" to value.zoom)
        is GraphLabelBox -> obj("x" to value.x, "y" to value.y, "width" to value.width, "height" to value.height, "text" to value.text, "lines" to value.lines, "scale" to value.scale)
        is GraphEdge -> obj("id" to value.id, "from" to value.from, "to" to value.to, "kind" to value.kind)
        is GraphFold -> obj("kind" to value.kind.stored, "label" to value.kind.label, "taskIds" to value.taskIds)
        is GraphReportCue -> obj("id" to value.id, "workerId" to value.workerId, "taskId" to value.taskId)
        else -> error("Missing JSON adapter for ${value.javaClass}")
    }
    private fun graphJSON(graph: TaskGraph) = obj(
        "nodes" to graph.nodes.map { obj("id" to it.id, "kind" to it.kind, "title" to it.title, "status" to it.status, "parent" to it.parent, "attention" to it.attention, "radius" to it.radius, "label" to graphLabel(it)) },
        "edges" to graph.edges, "resting" to graph.resting.map { it.id })
    private fun compare(expected: JsonElement, actual: JsonElement, path: String, geometry: Boolean = false) {
        when (expected) {
            is JsonObject -> {
                assertTrue(path, actual is JsonObject)
                val found = actual.jsonObject
                assertEquals("$path keys", expected.keys, found.keys)
                expected.forEach { (key, value) -> compare(value, found.getValue(key), "$path.$key", geometry) }
            }
            is JsonArray -> {
                assertTrue(path, actual is JsonArray)
                assertEquals("$path length", expected.size, actual.jsonArray.size)
                expected.forEachIndexed { i, value -> compare(value, actual.jsonArray[i], "$path[$i]", geometry) }
            }
            else -> {
                val number = (expected as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
                if (number != null) assertEquals(path, number, actual.jsonPrimitive.double, if (geometry && path.endsWith("zoom")) 1e-9 else if (geometry && path.endsWith("scale")) 1e-9 else if (geometry && !path.endsWith("radius")) .5 else 0.0)
                else assertEquals(path, expected, actual)
            }
        }
    }
    private fun kind(stored: String) = GraphFoldKind.entries.first { it.stored == stored }

    @Test fun sharedWebBubbleVectorsMatchModelLayoutFoldingCameraAndMotion() {
        var previous: Map<String, GraphPosition> = emptyMap()
        var previousGraph = TaskGraph(emptyList(), emptyList(), emptyList())
        var previousFold: GraphPosition? = null
        for (entry in vector.getValue("scenarios").jsonArray) {
            val s = entry.jsonObject; val name = s.text("name")
            if (!s.flag("retain")) { previous = emptyMap(); previousGraph = TaskGraph(emptyList(), emptyList(), emptyList()); previousFold = null }
            val input = vector.getValue("inputs").jsonArray[s.getValue("input").jsonPrimitive.int].jsonObject
            val tasks: List<BoardTask> = input.decode("tasks"); val questions: List<BoardQuestion> = input.decode("questions")
            val workers: List<WorkerSummary> = input.decode("workers"); val threads: List<ThreadSummary> = input.decode("threads")
            val graph = buildTaskGraph(tasks, questions, workers, threads, s.flag("showClosed"), s.flag("showResting"))
            compare(s.getValue("graph"), graphJSON(graph), "$name graph")
            val counts = graphCounts(graph)
            compare(s.getValue("counts"), obj("open" to counts.open, "working" to counts.working, "attention" to counts.attention), "$name counts")
            if (s.containsKey("reconciled")) {
                val reconciled = reconcileGraphPositions(graph, previous, s.number("aspect"))
                compare(s.getValue("reconciled"), json(reconciled), "$name reconciled", true)
                val stepped = reconciled.mapValuesTo(linkedMapOf()) { it.value.copy() }
                val energy = stepGraphLayout(stepped, previous.keys)
                compare(s.getValue("stepped"), json(stepped), "$name stepped", true)
                assertEquals("$name energy", s.number("energy"), energy, .000001)
            }
            val positions = settledGraphPositions(graph, previous, s.number("aspect"))
            compare(s.getValue("positions"), json(positions), "$name positions", true)
            // Retention is exact, not a tolerance: insertion/closing cannot nudge existing task bubbles.
            graph.nodes.filter { it.kind == "task" && it.id in previous }.forEach {
                assertEquals("$name retained x ${it.id}", previous.getValue(it.id).x, positions.getValue(it.id).x, 0.0)
                assertEquals("$name retained y ${it.id}", previous.getValue(it.id).y, positions.getValue(it.id).y, 0.0)
            }
            if (s.containsKey("interpolated")) {
                compare(s.getValue("interpolated"), json(interpolateGraphPositions(previous, positions, .35)), "$name interpolation", true)
                compare(s.getValue("handoff"), json(interpolateCrewHandoff(previous, positions, .35)), "$name handoff", true)
            }
            val folds = graphFoldGroups(graph, questions)
            compare(s.getValue("folds"), json(folds), "$name folds")
            val foldPosition = graphFoldPosition(positions, previousFold)
            compare(s.getValue("foldPosition"), json(foldPosition), "$name foldPosition", true)
            compare(s.getValue("expandedTodo"), json(graphFoldExpansion(graph, folds, setOf(GraphFoldKind.Todo)).map { it.stored }.sorted()), "$name expand")
            compare(s.getValue("closedTodo"), json(graphFoldExpansion(graph, folds, GraphFoldKind.entries.toSet(), GraphFoldKind.Todo).map { it.stored }.sorted()), "$name close")
            compare(s.getValue("revealed"), json(revealGraphTask(folds, emptySet(), "T4").map { it.stored }.sorted()), "$name reveal")
            s.getValue("modes").jsonArray.forEach { modeEntry ->
                val m = modeEntry.jsonObject
                val shown = liveTaskGraph(graph, folds, if (m.text("mode") == "all") GraphMode.All else GraphMode.Live,
                    m.getValue("expanded").jsonArray.map { kind(it.jsonPrimitive.content) }.toSet(), s.flag("showResting"))
                compare(m.getValue("graph"), obj("nodes" to shown.nodes.map { obj("id" to it.id, "parent" to it.parent) }, "edges" to shown.edges.map { it.id }, "resting" to shown.resting.map { it.id }), "$name ${m.text("mode")}")
                m.getValue("edges").jsonArray.forEach { edgeEntry ->
                    val e = edgeEntry.jsonObject
                    compare(e.getValue("ids"), json(visibleGraphEdges(shown, e.nullableText("focus"), e.flag("allLinks")).map { it.id }), "$name edges")
                    compare(e.getValue("highlighted"), json(graphNeighborhood(shown, e.nullableText("focus")).sorted()), "$name highlight")
                }
            }
            s.getValue("views").jsonArray.forEach { viewEntry ->
                val view = viewEntry.jsonObject
                val framing = positions + if (folds.isNotEmpty() && foldPosition != null) mapOf("folds" to foldPosition) else emptyMap()
                val camera = fitGraphCamera(framing, view.number("width"), view.number("height"))
                compare(view.getValue("camera"), json(camera), "$name camera", true)
                graph.nodes.filter { it.kind != "task" }.forEachIndexed { i, node ->
                    assertEquals(view.getValue("crewInView").jsonArray[i].jsonObject.flag("inView"), graphCrewInView(positions[node.id], camera, view.number("width"), view.number("height")))
                }
            }
            s.getValue("labels").jsonArray.forEach { labelEntry ->
                val labels = labelEntry.jsonObject
                assertEquals(labels.number("captionScale"), graphCaptionScale(labels.number("zoom")), 0.0)
                compare(labels.getValue("boxes"), json(placeGraphLabels(graph, positions, GraphCamera(zoom = labels.number("zoom")))), "$name labels", true)
            }
            graph.edges.forEachIndexed { i, edge ->
                val segment = graphEdgeSegment(positions.getValue(edge.from), positions.getValue(edge.to))
                compare(s.getValue("segments").jsonArray[i], obj("id" to edge.id, "x1" to segment.x1, "y1" to segment.y1, "x2" to segment.x2, "y2" to segment.y2), "$name segment", true)
            }
            graph.nodes.filter { it.kind != "task" }.forEachIndexed { i, node ->
                val crew = s.getValue("crew").jsonArray[i].jsonObject
                assertEquals(crew.text("motion"), graphCrewMotion(node, tasks, questions).name.lowercase())
                assertEquals(crew.getValue("delay").jsonPrimitive.long, -workerMotionPhase(node.id))
            }
            val departures = departingGraphCrew(previousGraph, graph, workers, threads)
            compare(s.getValue("departures"), json(departures.map { it.id }), "$name departures")
            compare(s.getValue("rendered"), json(renderedGraphNodes(graph, departures).map { it.id }), "$name rendered")
            compare(s.getValue("reports"), json(graphReportCues(workers.associate { it.id to null }, workers, graph)), "$name reports")
            previous = positions; previousGraph = graph; previousFold = foldPosition
        }
        val fixture = vector.getValue("inputs").jsonArray[0].jsonObject
        val baseTask = fixture.decode<List<BoardTask>>("tasks").first().copy(id = "T1")
        val baseQuestion = fixture.getValue("questions").jsonArray.first().jsonObject + ("taskId" to JsonPrimitive("T1"))
        vector.getValue("motion").jsonArray.forEach { motionEntry ->
            val m = motionEntry.jsonObject
            val task = m.nullableText("taskStatus")?.let { baseTask.copy(status = it) }
            val questions = if (m.getValue("ask") == JsonNull) emptyList() else listOf(wireJson.decodeFromJsonElement<BoardQuestion>(JsonObject(baseQuestion + m.getValue("ask").jsonObject)))
            assertEquals(m.text("motion"), workerMotion(m.text("status"), task, questions).name.lowercase())
        }
    }

    @Test fun cameraPreferenceIsValidatedAndScopedPerBackendAndProject() {
        val camera = GraphCamera(10.0, -30.0, .7)
        val settings = saveGraphCamera(DeviceSettings(), "https://one.example.test", "p", camera)
        val restored = wireJson.decodeFromString<DeviceSettings>(wireJson.encodeToString(DeviceSettings.serializer(), settings))
        assertEquals(camera, loadGraphCamera(restored, "https://one.example.test", "p"))
        assertNull(loadGraphCamera(restored, "https://one.example.test", "other"))
        assertNull(loadGraphCamera(restored, "https://two.example.test", "p"))
        assertNull(validGraphCamera(camera.copy(x = Double.NaN)))
        assertNull(validGraphCamera(camera.copy(zoom = .079)))
        assertNull(validGraphCamera(camera.copy(zoom = 4.01)))
        assertNotNull(validGraphCamera(camera.copy(zoom = .08)))
        assertNotNull(validGraphCamera(camera.copy(zoom = 4.0)))
        assertEquals(GraphCamera(), fitGraphCamera(emptyMap(), 390.0, 700.0))
        assertNull(graphFoldPosition(emptyMap()))
        assertTrue(wireJson.decodeFromString<DeviceSettings>("{}").projectBubbleCamera.isEmpty())
    }
}
