package io.github.mitzacoder.kemiri.features.artifacts

import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.features.tasks.media.comparePairs
import io.github.mitzacoder.kemiri.protocol.*
import java.time.*
import java.time.format.DateTimeFormatter
import java.util.Locale

internal data class LibraryProjectKey(val backend: String, val project: String)
internal data class LibraryArtifactKey(val project: LibraryProjectKey, val artifact: String)
internal data class LibraryArtifact(val key: LibraryArtifactKey, val artifact: Artifact, val project: ArtifactLibraryProject, val task: ArtifactTaskFacts?)
internal data class BackendLibrary(
    val artifacts: List<Artifact> = emptyList(),
    val projects: List<ArtifactLibraryProject> = emptyList(),
    val tasks: List<ArtifactTaskFacts> = emptyList(),
)
internal enum class LibraryLens(val label: String) {
    Task("By task"), Kind("By kind"), Time("By time"), Pairs("Before and after"), Living("Living"),
}
internal enum class ShelfShape { Phone, Screen, Recording, Picture, Paper, Slip, File }
internal data class LibraryShelf(val key: String, val title: String, val project: String?, val task: ArtifactTaskFacts?, val entries: List<LibraryArtifact>)

internal fun mergeLibraries(libraries: Map<String, BackendLibrary>): List<LibraryArtifact> = libraries.flatMap { (backend, library) ->
    val projects = library.projects.associateBy { it.id }
    val tasks = library.tasks.associateBy { it.projectId to it.id }
    library.artifacts.map { artifact ->
        val project = projects[artifact.projectId] ?: ArtifactLibraryProject(artifact.projectId, artifact.projectId, false)
        LibraryArtifact(LibraryArtifactKey(LibraryProjectKey(backend, project.id), artifact.id), artifact, project, tasks[project.id to artifact.taskId])
    }
}.distinctBy { it.key }.sortedWith(compareByDescending<LibraryArtifact> { instant(it.artifact.createdAt) }
    .thenBy { it.key.project.backend }.thenBy { it.key.project.project }.thenBy { it.key.artifact })

internal fun libraryKind(artifact: Artifact): String = if (artifact.kind == "text" &&
    (isHtmlArtifact(artifact.name, artifact.mimeType) || isMarkdownArtifact(artifact.name, artifact.mimeType))) "page" else artifact.kind

internal fun libraryKindLabel(kind: String, plural: Boolean = false): String = when (kind) {
    "text" -> if (plural) "Text and logs" else "Text"
    "audio" -> "Audio"
    else -> (when (kind) { "page" -> "Page"; "image" -> "Image"; "video" -> "Video"; else -> "File" }) + if (plural) "s" else ""
}

internal fun objectShape(artifact: Artifact): ShelfShape = when (libraryKind(artifact)) {
    "page" -> ShelfShape.Paper
    "text" -> ShelfShape.Slip
    "image", "video" -> when {
        artifact.tags.orEmpty().any { it == "android" || it == "phone" } -> ShelfShape.Phone
        artifact.tags.orEmpty().any { it == "desktop" || it == "web" } -> ShelfShape.Screen
        artifact.kind == "video" -> ShelfShape.Recording
        else -> ShelfShape.Picture
    }
    else -> ShelfShape.File
}

internal fun filterLibrary(entries: List<LibraryArtifact>, project: LibraryProjectKey?, tags: Set<String>, search: String): List<LibraryArtifact> {
    val words = search.lowercase().split(Regex("\\s+")).filter(String::isNotBlank)
    return entries.filter { entry ->
        val artifact = entry.artifact
        val searchable = (listOfNotNull(artifact.name, artifactTitle(artifact), artifact.taskId, entry.task?.title,
            libraryKindLabel(libraryKind(artifact)), artifact.kind) + artifact.tags.orEmpty()).joinToString(" ").lowercase()
        (project == null || entry.key.project == project) && artifact.tags.orEmpty().containsAll(tags) && words.all(searchable::contains)
    }
}

private fun instant(at: String): Instant? = runCatching { Instant.parse(at) }.getOrNull()
private fun localDate(at: String, zone: ZoneId = ZoneId.systemDefault()) = instant(at)?.atZone(zone)?.toLocalDate()
internal fun libraryDate(at: String): String = localDate(at)?.format(DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)) ?: at
private fun timeShelf(at: String, now: LocalDate, zone: ZoneId): String {
    val date = localDate(at, zone) ?: return "Unknown date"
    return when {
        date >= now.minusDays(now.dayOfWeek.value.toLong() - 1) -> "This week"
        YearMonth.from(date) == YearMonth.from(now) -> "Earlier this month"
        else -> date.format(DateTimeFormatter.ofPattern("MMMM yyyy", Locale.ENGLISH))
    }
}

internal fun libraryShelves(entries: List<LibraryArtifact>, lens: LibraryLens, now: LocalDate = LocalDate.now(), zone: ZoneId = ZoneId.systemDefault()): List<LibraryShelf> {
    if (lens == LibraryLens.Pairs) return emptyList()
    return entries.filter { lens != LibraryLens.Living || it.artifact.living != null }.groupBy { entry ->
        val artifact = entry.artifact
        when (lens) {
            LibraryLens.Task -> shelfKey(entry.key.project.backend, entry.project.id, artifact.taskId?.let { "task" } ?: "chat", artifact.taskId ?: artifact.threadId)
            LibraryLens.Kind -> libraryKind(artifact)
            LibraryLens.Time -> timeShelf(artifact.createdAt, now, zone)
            else -> "Kept alive"
        }
    }.map { (key, rows) ->
        val first = rows.first()
        val artifact = first.artifact
        when (lens) {
            LibraryLens.Task -> LibraryShelf(key, artifact.taskId?.let { first.task?.title ?: "Task $it" }
                ?: if (artifact.threadId == "main") "Main chat, no task" else "Chat, no task · ${artifact.threadId}", first.project.name, first.task, rows)
            LibraryLens.Kind -> LibraryShelf(key, libraryKindLabel(key, plural = true), null, null, rows)
            else -> LibraryShelf(key, key, null, null, rows)
        }
    }
}

internal fun shelfKey(vararg parts: String): String = parts.joinToString("") { "${it.length}:$it" }

internal fun libraryPairs(entries: List<LibraryArtifact>): List<Pair<LibraryArtifact, LibraryArtifact>> {
    val byAfter = buildMap {
        libraryShelves(entries, LibraryLens.Task).forEach { shelf ->
            val byId = shelf.entries.associateBy { it.artifact.id }
            comparePairs(shelf.entries.map { it.artifact }).values.toSet().forEach { pair ->
                val after = byId.getValue(pair.after.id)
                put(after.key, byId.getValue(pair.before.id) to after)
            }
        }
    }
    return entries.mapNotNull { byAfter[it.key] }
}

internal fun taskDoneSplit(versions: List<Artifact>, settledAt: String?): Int {
    val done = settledAt?.let(::instant) ?: return -1
    return versions.indexOfFirst { instant(it.createdAt)?.isAfter(done) == true }.takeIf { it > 0 } ?: -1
}

internal sealed interface ArtifactHistory {
    val at: String
    data class Save(val first: Artifact, val last: Artifact = first) : ArtifactHistory { override val at = first.createdAt }
    data class Comment(val comment: ArtifactComment) : ArtifactHistory { override val at = comment.at }
    data class Done(override val at: String) : ArtifactHistory
    data class Living(override val at: String) : ArtifactHistory
}

internal fun artifactHistory(versions: List<Artifact>, comments: List<ArtifactComment>, doneAt: String?, livingSince: String?): List<ArtifactHistory> {
    val events = versions.map { ArtifactHistory.Save(it) } + comments.map { ArtifactHistory.Comment(it) } +
        listOfNotNull(doneAt?.let(ArtifactHistory::Done), livingSince?.let(ArtifactHistory::Living))
    return buildList {
        for (event in events.sortedBy { instant(it.at) }) {
            val previous = lastOrNull()
            if (event is ArtifactHistory.Save && previous is ArtifactHistory.Save &&
                savedByLabel(previous.last) == savedByLabel(event.first) && previous.last.madeForTaskId == event.first.madeForTaskId &&
                (previous.last.version ?: 1) + 1 == event.first.version) {
                set(lastIndex, previous.copy(last = event.last))
            } else add(event)
        }
    }
}

internal fun withoutArtifactReference(text: String): String = text.lineSequence()
    .filterNot { it.trim().matches(Regex("\\(artifact [^\\n]+\\)")) }.joinToString("\n").trim()

internal fun boardTaskFolders(project: String, board: Board): List<ArtifactTaskFolder> = board.tasks.map { task ->
    ArtifactTaskFolder(project, task.id, task.title, task.status, task.archived, task.settledAt, task.report.summary,
        board.decisions.filter { it.taskId == task.id }.map { ArtifactTaskFolderDecisionsItem(it.id, it.text, it.why, it.at) })
}

internal fun ArtifactTaskFolder.facts() = ArtifactTaskFacts(projectId, id, title, status, archived, settledAt, summary)
