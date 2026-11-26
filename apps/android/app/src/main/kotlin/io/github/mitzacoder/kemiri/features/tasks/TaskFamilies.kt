package io.github.mitzacoder.kemiri.features.tasks

enum class TaskFamilyRole { Task, ParentHeader, Pointer }

/** Keep folded branches by ID so the list can animate them without moving pinned attention rows. */
data class TaskFamilyBranch(val family: TaskFamily, val visible: Boolean)

data class TaskFamily(
    val row: TaskRow,
    val role: TaskFamilyRole,
    val branches: List<TaskFamilyBranch>,
    val canToggle: Boolean,
    val expanded: Boolean,
    val foldedCount: Int,
    val doneParts: Int = 0,
) {
    val children: List<TaskFamily> get() = branches.filter { it.visible }.map { it.family }
}

private fun TaskRow.needsOwner() = task.state?.group == "needs_you"

/** List-only relocation; search and board retain their ordinary state sections. */
fun taskFamilySections(sections: List<TaskSection>, requestAttention: Boolean = false): List<TaskSection> {
    if (requestAttention) return sections.map { it.copy(rows = it.rows.filter { row -> row.task.parent == null }, parentRows = emptyList()) }
        .filter { it.rows.isNotEmpty() }
    val rows = sections.flatMap { it.rows }
    val byId = rows.associateBy { it.task.id }
    fun familySection(row: TaskRow): TaskSectionId {
        val seen = hashSetOf(row.task.id)
        var ancestor = row
        while (ancestor.task.state != null && ancestor.task.parent != null) {
            val parent = byId[ancestor.task.parent]?.takeIf { it.task.state != null } ?: break
            if (!seen.add(parent.task.id)) return row.section
            ancestor = parent
        }
        return ancestor.section
    }
    val familySections = rows.associate { it.task.id to familySection(it) }
    return sections.map { section ->
        val needsYou = section.id == TaskSectionId.NeedsYou
        val members = rows.filter { familySections[it.task.id] == section.id || (needsYou && it.needsOwner()) }
        val parentRows = if (needsYou) {
            val memberIds = members.mapTo(hashSetOf()) { it.task.id }
            members.filter { it.needsOwner() }.mapNotNull { row ->
                byId[row.task.parent]?.takeIf { it.task.state != null && !it.task.archived && it.task.id !in memberIds }
            }.distinctBy { it.task.id }
        } else emptyList()
        section.copy(rows = members, parentRows = parentRows)
    }.filter { it.rows.isNotEmpty() }
}

fun taskFamilyCount(section: TaskSection, requestAttention: Boolean = false): Int = when {
    requestAttention -> section.rows.size
    section.rows.none { it.task.state != null } -> section.rows.size
    section.id == TaskSectionId.NeedsYou -> section.rows.count { it.needsOwner() }
    else -> taskFamilies(section).size
}

fun needsFamilyAttention(row: TaskRow): Boolean =
    row.waiting.isNotEmpty() || (row.task.state?.group?.let { it in setOf("needs_you", "waiting") } ?: (row.task.status in setOf("review", "blocked", "waiting")))

fun familySectionStartsOpen(section: TaskSection): Boolean =
    section.id != TaskSectionId.Later && (section.rows.any(::needsFamilyAttention) || !section.collapsedByDefault)

/**
 * Derived families nest across states; legacy families retain same-status nesting.
 * Needs-you parts have their full row in Needs you, with a foldable pointer in a different family section.
 */
fun taskFamilies(
    section: TaskSection, expansion: Map<String, Boolean> = emptyMap(), partsByRequest: Map<String, List<TaskRow>>? = null,
): List<TaskFamily> {
    if (partsByRequest != null) return section.rows.map { row ->
        val task = row.task
        val showParts = section.id !in setOf(TaskSectionId.NeedsYou, TaskSectionId.Closed)
        val parts = if (showParts) partsByRequest[task.id].orEmpty() else emptyList()
        val done = if (!showParts) 0 else task.partsDigest?.parts?.count { it.state == "done" }
            ?: parts.count { it.task.status == "done" }
        val canToggle = parts.isNotEmpty() || done > 0
        val expanded = canToggle && expansion[task.id] == true
        val branches = if (expanded) requestPartRows(parts).map {
            TaskFamilyBranch(TaskFamily(it, TaskFamilyRole.Task, emptyList(), false, false, 0), visible = true)
        } else emptyList()
        TaskFamily(row, TaskFamilyRole.Task, branches, canToggle, expanded, parts.size, doneParts = if (expanded) done else 0)
    }
    val needsYou = section.id == TaskSectionId.NeedsYou
    val byId = section.rows.associateBy { it.task.id }
    val parents = linkedMapOf<String, String>()
    section.rows.forEach { row ->
        val parent = byId[row.task.parent]
        if (parent != null && ((parent.task.state != null && row.task.state != null) || parent.task.status == row.task.status) && parent.task.id != row.task.id) {
            parents[row.task.id] = parent.task.id
        }
    }
    // The server rejects cycles, but partial/stale state must not make tasks disappear.
    parents.keys.toList().forEach { id ->
        val seen = hashSetOf(id)
        var ancestor = parents[id]
        while (ancestor != null) {
            if (!seen.add(ancestor)) { parents.remove(id); break }
            ancestor = parents[ancestor]
        }
    }
    val children = section.rows.filter { it.task.id in parents }.groupBy { parents.getValue(it.task.id) }
    val order = section.rows.mapIndexed { index, row -> row.task.id to index }.toMap()
    val attention = mutableMapOf<String, Boolean>()
    fun mustShow(row: TaskRow): Boolean = attention.getOrPut(row.task.id) {
        val pinned = when {
            row.task.state == null -> needsFamilyAttention(row)
            row.needsOwner() -> needsYou
            else -> row.waiting.isNotEmpty() && !isSettled(row.task.status)
        }
        pinned || children[row.task.id].orEmpty().any(::mustShow)
    }
    fun branchCount(row: TaskRow): Int = 1 + children[row.task.id].orEmpty().sumOf(::branchCount)
    val quietOrder = compareBy<TaskRow> { isSettled(it.task.status) }.thenBy { it.task.order }
    val needsYouOrder = compareBy<TaskRow> { !it.needsOwner() }
        .thenBy { if (it.needsOwner()) order.getValue(it.task.id) else Int.MAX_VALUE }
        .then(quietOrder)
    fun family(row: TaskRow): TaskFamily {
        val nested = children[row.task.id].orEmpty().let {
            when {
                row.task.state == null -> it
                needsYou -> it.sortedWith(needsYouOrder)
                else -> it.sortedWith(quietOrder)
            }
        }
        val canToggle = nested.any { !mustShow(it) }
        val expanded = canToggle && expansion[row.task.id] == true
        val role = if (!needsYou && row.needsOwner() && row.task.id in parents) TaskFamilyRole.Pointer else TaskFamilyRole.Task
        return TaskFamily(
            row = row, role = role, canToggle = canToggle, expanded = expanded,
            branches = nested.map { TaskFamilyBranch(family(it), expanded || mustShow(it)) },
            foldedCount = nested.filter { !expanded && !mustShow(it) }.sumOf(::branchCount),
        )
    }
    val roots = section.rows.filter { it.task.id !in parents }
    if (!needsYou || section.rows.none { it.task.state != null }) return roots.map(::family)

    val headers = section.parentRows.associateBy { it.task.id }
    val partsByParent = roots.filter { it.needsOwner() && it.task.parent in headers }.groupBy { it.task.parent }
    val groups = roots.filterNot { it.needsOwner() && it.task.parent in headers }.map(::family) +
        partsByParent.map { (parent, parts) ->
            TaskFamily(headers.getValue(parent!!), TaskFamilyRole.ParentHeader,
                parts.sortedWith(needsYouOrder).map { TaskFamilyBranch(family(it), visible = true) },
                canToggle = false, expanded = true, foldedCount = 0)
        }
    fun urgency(group: TaskFamily): Int {
        val own = if (group.row.needsOwner()) order.getValue(group.row.task.id) else Int.MAX_VALUE
        return minOf(own, group.children.minOfOrNull(::urgency) ?: Int.MAX_VALUE)
    }
    return groups.sortedWith(compareBy<TaskFamily>(::urgency).thenBy { order[it.row.task.id] ?: Int.MAX_VALUE })
}
