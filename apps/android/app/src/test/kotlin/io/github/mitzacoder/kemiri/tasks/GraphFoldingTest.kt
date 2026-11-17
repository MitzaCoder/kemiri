package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.data.DeviceSettings
import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.features.tasks.graph.*
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class GraphFoldingTest {
    private fun state(kind: String, group: String = "waiting") = BoardTaskState(kind = kind, group = group, refs = emptyList(), since = "2026-01-01T00:00:00Z")
    private fun model(tasks: List<BoardTask>, questions: List<BoardQuestion> = emptyList(), workers: List<WorkerSummary> = emptyList()) =
        buildGraphModel(tasks, questions, workers, emptyList(), 0)
    private fun folds(m: GraphModel) = graphFoldGroups(m, m.details.keys)
    private fun worker(id: String, taskId: String?, status: String) = WorkerSummary(id = id, title = id, status = status,
        model = ModelRef(provider = "faux", modelId = "faux-1"), thinkingLevel = null, isolation = "shared", workspacePath = null,
        conversationId = 1, taskId = taskId, spawnedByCallId = null, createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z", lastReport = null, failure = null)

    @Test fun onlyQuietSinglesFoldAndDerivedAttentionWins() {
        val kinds = listOf("failed", "answer_needed", "review", "working", "clarifying", "paused", "blocked_by_task", "todo", "waiting_outside", "done", "dropped")
        val m = model(kinds.mapIndexed { index, kind -> task("T${index + 1}").copy(state = state(kind, if (kind in listOf("failed", "answer_needed", "review")) "needs_you" else if (kind == "todo") "todo" else "waiting")) })
        assertEquals(listOf(GraphFold(GraphFoldKind.Todo, listOf("T8")), GraphFold(GraphFoldKind.Waiting, listOf("T9"))), folds(m))
        assertEquals(m.details.keys - setOf("T8", "T9"), graphShownTaskIds(m, m.details.keys, folds(m), GraphMode.Live, emptySet()))
        assertSame(m.details.keys, graphShownTaskIds(m, m.details.keys, folds(m), GraphMode.All, emptySet()))
        assertTrue(folds(model(listOf(task("T1").copy(state = state("todo", "needs_you"))))).isEmpty())
    }
    @Test fun legacySectionsQuestionsAndWaitingDirectionMatchWeb() {
        val m = model(listOf(task("T1"), task("T2", status = "waiting"), task("T3", status = "review"), task("T4", status = "blocked"), task("T5", status = "in_progress"), task("T6")),
            listOf(question("Q1", "T1"), question("Q2", "T6").copy(waitingOn = "agent")))
        assertEquals(listOf(listOf("T6"), listOf("T2")), folds(m).map { it.taskIds })
    }
    @Test fun everyFamilyStaysIncludingQuietOnlyAndReportedHiddenParts() {
        val m = model(listOf(task("T1"), task("T2", status = "in_progress").copy(parent = "T1"), task("T3").copy(parent = "T1"),
            task("T4").copy(parent = "T3"), task("T5"), task("T6").copy(parent = "T5"),
            task("T7").copy(subtaskCount = BoardSubtaskCount(done = 1, total = 1)), task("T8")))
        assertEquals(listOf("T8"), folds(m).single().taskIds)
    }
    @Test fun recursivePrerequisitesStayButReverseDependentsAndOtherRelationsDoNot() {
        val m = model(listOf(task("T1", status = "in_progress").copy(blockedBy = listOf("T2")), task("T2").copy(blockedBy = listOf("T3")), task("T3"),
            task("T4").copy(blockedBy = listOf("T1")), task("T5").copy(foundWhile = "T1", related = listOf("T2"))))
        assertEquals(listOf("T4", "T5"), folds(m).single().taskIds)
        val cycle = model(listOf(task("T1", status = "in_progress").copy(blockedBy = listOf("T2")), task("T2").copy(blockedBy = listOf("T1"))))
        assertTrue(folds(cycle).isEmpty())
    }
    @Test fun openingPrerequisitesAndClosingDependentsTerminateEvenWithCycles() {
        val m = model(listOf(task("T1").copy(blockedBy = listOf("T2")), task("T2", status = "waiting").copy(blockedBy = listOf("T1"))))
        val groups = folds(m)
        assertEquals(listOf(GraphFoldKind.Todo, GraphFoldKind.Waiting), groups.map { it.kind })
        val revealed = revealGraphTask(groups, emptySet(), "T1")
        assertEquals(setOf(GraphFoldKind.Todo), revealed)
        val expanded = graphFoldExpansion(m, groups, revealed)
        assertEquals(GraphFoldKind.entries.toSet(), expanded)
        assertEquals(m.details.keys, graphShownTaskIds(m, m.details.keys, groups, GraphMode.Live, revealed))
        assertTrue(graphFoldExpansion(m, groups, expanded, GraphFoldKind.Waiting).isEmpty())
        assertEquals(expanded, revealGraphTask(groups, expanded, "missing"))
    }
    @Test fun idleCrewOnFoldedTasksRestWhileRunningAndFailedAssignmentsStay() {
        val m = model((1..3).map { task("T$it") }, workers = listOf(worker("busy", "T1", "running"), worker("idle", "T2", "idle"), worker("failed", "T3", "failed")))
        val groups = folds(m)
        assertEquals(listOf("T2"), groups.single().taskIds)
        val shown = graphShownTaskIds(m, m.details.keys, groups, GraphMode.Live, emptySet())
        assertEquals(listOf("idle"), m.restingWorkers(shown).map { it.id })
        assertTrue(m.restingWorkers(graphShownTaskIds(m, m.details.keys, groups, GraphMode.Live, setOf(GraphFoldKind.Todo))).isEmpty())
        val layout = layoutGraphFamilies(m.details.values.map { GraphLayoutTask(it.task.id, null, it.familyId) })
        assertFalse(graphCrewPlacements(layout, m, shown).any { it.taskId == "T2" })
    }
    @Test fun busyBackgroundJobsAndTheirRunningWorkersProtectOnlyTheShownAssignment() {
        val tasks = (1..3).map { task("T$it") }
        val thread = ThreadSummary(id = "garden", title = "Sample job", status = "running", main = false,
            startedBy = "main", scheduleId = null, conversationId = 2, model = null, thinkingLevel = null, onFinish = "record",
            runningWorkers = 0, taskId = "T1", ownedTasks = listOf("T2"), openQuestions = 0, current = null, summary = null,
            failure = null, createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z", finishedAt = null, archived = false)
        for (status in listOf("running", "failed")) {
            val m = buildGraphModel(tasks, emptyList(), emptyList(), listOf(thread.copy(status = status)), 0)
            assertEquals(listOf("T2", "T3"), folds(m).single().taskIds)
        }
        val idleJob = thread.copy(status = "idle")
        val child = worker("child", null, "running").copy(threadId = "garden")
        assertEquals(listOf("T2", "T3"), folds(buildGraphModel(tasks, emptyList(), listOf(child), listOf(idleJob), 0)).single().taskIds)
        assertEquals(listOf("T1", "T2", "T3"), folds(buildGraphModel(tasks, emptyList(), emptyList(), listOf(idleJob), 0)).single().taskIds)
    }
    @Test fun modeAndChipChangesNeverAlterFullGraphGeometry() {
        val m = model(listOf(task("T1", status = "in_progress"), task("T2"), task("T3", status = "waiting")))
        val inputs = m.details.values.map { GraphLayoutTask(it.task.id, null, it.familyId) }
        val canvas = GraphCanvasState()
        val layout = canvas.geometry(inputs, GraphLayoutOptions())
        canvas.camera = GraphCamera(12f, 24f, 1.1f)
        val camera = canvas.camera
        for (mode in listOf(GraphMode.Live, GraphMode.All, GraphMode.Live)) for (expanded in listOf(emptySet(), setOf(GraphFoldKind.Todo), emptySet())) {
            val shown = graphShownTaskIds(m, m.details.keys, folds(m), mode, expanded)
            assertSame(layout, canvas.geometry(inputs, GraphLayoutOptions()))
            assertEquals(camera, canvas.camera)
            shown.forEach { assertEquals(layout.cards[it], canvas.layout?.cards?.get(it)) }
        }
        val arrival = inputs + GraphLayoutTask("T4", null, "T4")
        val next = canvas.geometry(arrival, GraphLayoutOptions())
        layout.cards.forEach { (id, card) -> assertEquals(card.box, next.cards.getValue(id).box) }
        assertTrue("T4" in next.cards)
    }
    @Test fun graphModeIsProjectScopedDefaultsLiveAndDoesNotPersistChipExpansion() {
        val saved = DeviceSettings().withGraphMode("https://one.example.test", "p", GraphMode.All)
        val restored = wireJson.decodeFromString(DeviceSettings.serializer(), wireJson.encodeToString(DeviceSettings.serializer(), saved))
        assertEquals(GraphMode.All, restored.graphMode("https://one.example.test", "p"))
        assertEquals(GraphMode.Live, restored.graphMode("https://one.example.test", "q"))
        assertEquals(GraphMode.Live, restored.graphMode("https://two.example.test", "p"))
        assertEquals(GraphMode.Live, graphMode("invalid"))
        assertEquals(GraphMode.Live, graphMode(null))
    }
    @Test fun sharedWebFoldVectorsMatchGroupsAndDependencyExpansion() {
        val file = generateSequence(File(System.getProperty("user.dir")!!)) { it.parentFile }.map { File(it, "apps/android/test-vectors/task-graph-v1.json") }.first { it.isFile }
        val cases = wireJson.parseToJsonElement(file.readText()).jsonObject.getValue("folding").jsonArray
        cases.forEach { case ->
            val v = case.jsonObject
            val tasks = v.getValue("tasks").jsonArray.map { input ->
                val t = input.jsonObject
                fun text(key: String) = t[key]?.jsonPrimitive?.contentOrNull
                fun ids(key: String) = t[key]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()
                task(text("id")!!, status = text("status") ?: "todo").copy(parent = text("parent"), blockedBy = ids("blockedBy"), foundWhile = text("foundWhile"), related = ids("related"),
                    state = t["state"]?.let { wireJson.decodeFromJsonElement(BoardTaskState.serializer(), it) },
                    subtaskCount = t["subtaskCount"]?.let { wireJson.decodeFromJsonElement(BoardSubtaskCount.serializer(), it) })
            }
            val workers = v.getValue("workers").jsonArray.map { it.jsonObject.let { w -> worker(w.getValue("id").jsonPrimitive.content, w["taskId"]?.jsonPrimitive?.contentOrNull, w.getValue("status").jsonPrimitive.content) } }
            val questions = v.getValue("questions").jsonArray.map { it.jsonObject.let { q -> question(q.getValue("id").jsonPrimitive.content, q.getValue("taskId").jsonPrimitive.content).copy(waitingOn = q["waitingOn"]?.jsonPrimitive?.contentOrNull) } }
            val m = model(tasks, questions, workers)
            val groups = folds(m)
            val expected = v.getValue("groups").jsonArray.map { g -> g.jsonObject.let { GraphFold(GraphFoldKind.entries.first { kind -> kind.stored == it.getValue("kind").jsonPrimitive.content }, it.getValue("taskIds").jsonArray.map { id -> id.jsonPrimitive.content }) } }
            assertEquals(v.getValue("name").jsonPrimitive.content, expected, groups)
            val expanded = graphFoldExpansion(m, groups, setOf(GraphFoldKind.Todo))
            assertEquals(v.getValue("expandedTodo").jsonArray.map { it.jsonPrimitive.content }.toSet(), expanded.map { it.stored }.toSet())
        }
    }
}
