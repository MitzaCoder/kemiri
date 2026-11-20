package io.github.mitzacoder.kemiri.features.artifacts

import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.coroutines.CancellationException

internal data class LibraryRead(val library: BackendLibrary = BackendLibrary(), val problem: String? = null, val loaded: Boolean = false)

internal suspend fun readLibrary(backend: BackendSession, projects: List<ProjectSummary>, supported: Boolean): LibraryRead {
    val client = backend.client
    val artifacts = mutableListOf<Artifact>()
    val libraryProjects = mutableListOf<ArtifactLibraryProject>()
    val tasks = mutableListOf<ArtifactTaskFacts>()
    var partial = false
    if (supported) {
        var before: String? = null
        val cursors = mutableSetOf<String>()
        do {
            val page = client.request(ArtifactsLibraryRequest(before = before))
            artifacts += page.artifacts
            libraryProjects += page.projects
            tasks += page.tasks
            before = page.nextBefore
            check(before == null || cursors.add(before)) { "The library repeated a page." }
        } while (before != null)
    } else {
        for (project in projects) {
            libraryProjects += ArtifactLibraryProject(project.id, project.name, project.archived == true)
            try { artifacts += client.request(ArtifactsListRequest(projectId = project.id, limit = 500)).artifacts }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { partial = true; continue }
            tasks += readArtifactBoard(backend, project.id).map { it.facts() }
        }
    }
    return LibraryRead(BackendLibrary(artifacts, libraryProjects, tasks),
        problem = if (partial) "Some projects could not be read." else null, loaded = true)
}

internal suspend fun readArtifactBoard(backend: BackendSession, project: String): List<ArtifactTaskFolder> = try {
    boardTaskFolders(project, backend.client.request(BoardGetRequest(projectId = project, includeArchived = true)).board)
} catch (e: CancellationException) { throw e }
catch (_: Exception) { emptyList() }
