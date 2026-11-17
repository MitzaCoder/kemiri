package io.github.mitzacoder.kemiri.features.tasks

/** Visible children only; families default folded. Mirrors web task-families.ts. */
data class TaskFamily(
    val row: TaskRow,
    val children: List<TaskFamily>,
    val canToggle: Boolean,
    val expanded: Boolean,
    val foldedCount: Int,
)

/** List-only relocation; search and board retain their ordinary state sections. */
fun taskFamilySections(sections: List<TaskSection>): List<TaskSection> {
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
    return sections.map { section -> section.copy(rows = rows.filter {
        familySection(it) == section.id || (it.task.state?.group == "needs_you" && section.id == TaskSectionId.NeedsYou)
    }) }.filter { it.rows.isNotEmpty() }
}

fun taskFamilyCount(section: TaskSection): Int =
    if (section.rows.any { it.task.state != null }) taskFamilies(section).size else section.rows.size

fun needsFamilyAttention(row: TaskRow): Boolean =
    row.waiting.isNotEmpty() || (row.task.state?.group?.let { it in setOf("needs_you", "waiting") } ?: (row.task.status in setOf("review", "blocked", "waiting")))

fun familySectionStartsOpen(section: TaskSection): Boolean =
    section.rows.any(::needsFamilyAttention) || !section.collapsedByDefault

/**
 * Derived families nest across states; legacy families retain same-status nesting.
 * Needs-you parts also have independent root rows, so their family copies can fold.
 */
fun taskFamilies(section: TaskSection, expansion: Map<String, Boolean> = emptyMap()): List<TaskFamily> {
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
    val children = section.rows.filter { it.task.id in parents }.groupBy { parents[it.task.id]!! }
    val attention = mutableMapOf<String, Boolean>()
    fun mustShow(row: TaskRow): Boolean = attention.getOrPut(row.task.id) {
        (if (row.task.state != null) row.task.state.group != "needs_you" && row.waiting.isNotEmpty() && !isSettled(row.task.status) else needsFamilyAttention(row)) || children[row.task.id].orEmpty().any { mustShow(it) }
    }
    fun branchCount(row: TaskRow): Int = 1 + children[row.task.id].orEmpty().sumOf { branchCount(it) }
    fun family(row: TaskRow): TaskFamily {
        val nested = children[row.task.id].orEmpty().let { if (row.task.state != null) it.sortedWith(compareBy<TaskRow> { isSettled(it.task.status) }.thenBy { it.task.order }) else it }
        val canToggle = nested.any { !mustShow(it) }
        val expanded = canToggle && expansion[row.task.id] == true
        return TaskFamily(
            row = row, canToggle = canToggle, expanded = expanded,
            children = nested.filter { expanded || mustShow(it) }.map { family(it) },
            foldedCount = nested.filter { !expanded && !mustShow(it) }.sumOf { branchCount(it) },
        )
    }
    return section.rows.filter { it.task.id !in parents || (section.id == TaskSectionId.NeedsYou && it.task.state?.group == "needs_you") }.map {
        if (section.id == TaskSectionId.NeedsYou && it.task.id in parents && it.task.state?.group == "needs_you")
            TaskFamily(it, emptyList(), false, false, 0)
        else family(it)
    }
}
