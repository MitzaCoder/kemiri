package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.features.tasks.graph.*
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.*
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.GraphCamera
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class BubbleCanvasTest {
    @Test fun screenGesturesKeepTheWorldCentreAndClampZoom() {
        val vectors = generateSequence(File(System.getProperty("user.dir")!!)) { it.parentFile }
            .map { File(it, "apps/android/test-vectors/task-graph-bubble-v1.json") }.first { it.isFile }
        wireJson.parseToJsonElement(vectors.readText()).jsonObject.getValue("cameraGestures").jsonArray.forEach { entry ->
            val v = entry.jsonObject
            val camera = wireJson.decodeFromJsonElement(GraphCamera.serializer(), v.getValue("camera"))
            val moved = zoomGraphCamera(panGraphCamera(camera, v.getValue("dx").jsonPrimitive.double, v.getValue("dy").jsonPrimitive.double), v.getValue("factor").jsonPrimitive.double)
            assertEquals(wireJson.decodeFromJsonElement(GraphCamera.serializer(), v.getValue("expected")), moved)
        }
    }
    @Test fun foldingNeverMovesSlotsOrChangesTheCamera() {
        val graph = buildTaskGraph(listOf(task("T1", "in_progress"), task("T2"), task("T3", "waiting")), emptyList(), emptyList(), emptyList())
        val positions = settledGraphPositions(graph)
        val saved = positions.mapValues { it.value.copy() }
        val state = BubbleCanvasState(GraphCamera(12.0, 24.0, 1.1)).also { it.positions = positions }
        val groups = graphFoldGroups(graph)
        for (mode in listOf(GraphMode.Live, GraphMode.All, GraphMode.Live)) for (expanded in listOf(emptySet(), setOf(GraphFoldKind.Todo), emptySet())) {
            val shown = liveTaskGraph(graph, groups, mode, expanded)
            assertSame(positions, state.positions)
            assertEquals(saved, state.positions)
            assertEquals(GraphCamera(12.0, 24.0, 1.1), state.camera)
            shown.nodes.forEach { assertNotNull(positions[it.id]) }
        }
    }
    @Test fun cameraAndModePersistPerProjectButChipChoicesDoNot() {
        val camera = GraphCamera(100.0, -200.0, .35)
        val saved = saveGraphCamera(DeviceSettings().withGraphMode("https://one.example.test", "p", GraphMode.All), "https://one.example.test", "p", camera)
        val restored = wireJson.decodeFromString(DeviceSettings.serializer(), wireJson.encodeToString(DeviceSettings.serializer(), saved))
        assertEquals(camera, loadGraphCamera(restored, "https://one.example.test", "p"))
        assertNull(loadGraphCamera(restored, "https://one.example.test", "q"))
        assertNull(loadGraphCamera(restored, "https://two.example.test", "p"))
        assertEquals(GraphMode.All, restored.graphMode("https://one.example.test", "p"))
        assertEquals(GraphMode.Live, restored.graphMode("https://one.example.test", "q"))
        assertEquals(GraphMode.Live, graphMode("invalid"))
        assertNull(validGraphCamera(camera.copy(zoom = Double.NaN)))
    }
}
