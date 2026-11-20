package io.github.mitzacoder.kemiri.artifacts

import io.github.mitzacoder.kemiri.features.artifacts.*
import io.github.mitzacoder.kemiri.protocol.*
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneOffset

/** Same grouping, filtering, pairing and chronology cases as web/test/artifact-library.test.ts. */
class ArtifactLibraryTest {
    private fun at(day: Int) = LocalDate.of(2026, 11, 1).plusDays(day - 1L).atTime(12, 0).toInstant(ZoneOffset.UTC).toString()
    private val project = ArtifactLibraryProject("bakery", "Juniper Bakery", false)
    private val archive = ArtifactLibraryProject("market", "Market notes", true)
    private val task = ArtifactTaskFacts(project.id, "T1", "Publish the autumn menu", "done", true, at(5))
    private fun row(id: String) = Artifact(id = id, projectId = project.id, name = "$id.png", title = null, note = null,
        kind = "image", mimeType = "image/png", size = 10, durationSeconds = null, threadId = "main", workerId = null,
        taskId = task.id, sourcePath = "/tmp/$id.png", createdAt = at(20))
    private fun entries(vararg artifacts: Artifact) = mergeLibraries(mapOf("local" to BackendLibrary(artifacts.toList(), listOf(project, archive), listOf(task))))

    @Test fun identitiesIncludeProjectAndBackendAndRetainArchivedTasks() {
        val same = row("same")
        val rows = mergeLibraries(mapOf(
            "local" to BackendLibrary(listOf(same, same.copy(projectId = archive.id), same), listOf(project, archive),
                listOf(task, task.copy(projectId = archive.id, title = "Choose a supplier"))),
            "remote" to BackendLibrary(listOf(same.copy(createdAt = at(21))), listOf(project), listOf(task.copy(title = "Another bakery"))),
        ))
        assertEquals(listOf("Another bakery", task.title, "Choose a supplier"), rows.map { it.task?.title })
        assertEquals(3, libraryShelves(rows, LibraryLens.Task).size)
        assertTrue(rows.last().project.archived)
    }

    @Test fun taskShelvesStayNewestFirstAndChatsStaySeparate() {
        val shelves = libraryShelves(entries(row("old").copy(createdAt = at(1)), row("chat-a").copy(taskId = null, createdAt = at(18)),
            row("chat-b").copy(taskId = null, threadId = "notes", createdAt = at(17)), row("new")), LibraryLens.Task)
        assertEquals(listOf(listOf("new", "old"), listOf("chat-a"), listOf("chat-b")), shelves.map { it.entries.map { entry -> entry.artifact.id } })
        assertEquals("done", shelves.first().task?.status)
    }

    @Test fun kindTimeAndLivingShelvesMatchWeb() {
        val rows = entries(row("old").copy(createdAt = at(0)), row("middle").copy(createdAt = at(5), name = "sales.md", kind = "text"),
            row("new").copy(living = ArtifactLiving(at(19))))
        assertEquals(listOf("Images", "Pages"), libraryShelves(rows, LibraryLens.Kind).map { it.title })
        assertEquals(listOf("This week", "Earlier this month", "October 2026"), libraryShelves(rows, LibraryLens.Time, LocalDate.of(2026, 11, 20), ZoneOffset.UTC).map { it.title })
        assertEquals(listOf("new"), libraryShelves(rows, LibraryLens.Living).flatMap { it.entries }.map { it.artifact.id })
    }

    @Test fun filtersRequireEveryWordAndTag() {
        val rows = entries(row("checkout").copy(title = "Front counter", tags = listOf("web", "phone")), row("other"))
        assertEquals(listOf("checkout"), filterLibrary(rows, rows.first().key.project, setOf("web"), "front checkout AUTUMN image phone").map { it.artifact.id })
        assertTrue(filterLibrary(rows, rows.first().key.project, setOf("dark"), "front").isEmpty())
    }

    @Test fun shapesFollowKindAndPlatformTags() {
        val shapes = listOf(row("phone").copy(tags = listOf("web", "android")), row("screen").copy(tags = listOf("desktop")),
            row("clip").copy(kind = "video"), row("report").copy(kind = "text", name = "report.html"), row("note").copy(kind = "text", name = "note.md"),
            row("log").copy(kind = "text", name = "run.log"), row("pdf").copy(kind = "file")).map(::objectShape)
        assertEquals(listOf(ShelfShape.Phone, ShelfShape.Screen, ShelfShape.Recording, ShelfShape.Paper, ShelfShape.Paper, ShelfShape.Slip, ShelfShape.File), shapes)
    }

    @Test fun pairsRequireExactlyMatchingTagsAndStayWithinTheTaskAndProject() {
        val before = row("before").copy(tags = listOf("phone", "before", "web"), createdAt = at(18))
        val after = row("after").copy(tags = listOf("after", "web", "phone"))
        val rows = entries(before, after, after.copy(id = "dark", tags = after.tags.orEmpty() + "dark"), before.copy(id = "other-task", taskId = "T2"),
            after.copy(id = "other-project", projectId = archive.id))
        assertEquals(listOf("before" to "after"), libraryPairs(rows).map { (a, b) -> a.artifact.id to b.artifact.id })
    }

    @Test fun savesGroupWithoutCrossingCompletionCommentsOrLaterTaskSaves() {
        val versions = (1..4).map { row("v$it").copy(version = it.toLong(), createdAt = at(2 * it + 1), madeForTaskId = "T2".takeIf { _ -> it == 4 }) }
        assertEquals(2, taskDoneSplit(versions, at(5)))
        assertEquals(-1, taskDoneSplit(versions, at(1)))
        assertEquals(-1, taskDoneSplit(versions, at(10)))
        val comment = ArtifactComment("T1", "F1", 3, "Show the order total\n\n(artifact menu~3)", at(8), "addressed", "Added.")
        val history = artifactHistory(versions, listOf(comment), at(5), at(6))
        assertEquals(listOf(ArtifactHistory.Save(versions[0], versions[1]), ArtifactHistory.Done(at(5)), ArtifactHistory.Living(at(6)),
            ArtifactHistory.Save(versions[2]), ArtifactHistory.Comment(comment), ArtifactHistory.Save(versions[3])), history)
        assertEquals("Show the order total", withoutArtifactReference(comment.text))
        assertEquals(2, artifactHistory(versions.takeLast(2), emptyList(), null, null).size)
    }
}
