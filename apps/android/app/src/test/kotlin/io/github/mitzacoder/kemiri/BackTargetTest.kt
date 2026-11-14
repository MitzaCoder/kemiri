package io.github.mitzacoder.kemiri

import io.github.mitzacoder.kemiri.navigation.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class BackTargetTest {
    @Test fun a5SelectedServerCataloguePresetAndImportReviewBackBeforeLeavingMcp() {
        for (views in listOf(
            listOf("MCP", "server"), listOf("MCP", "catalogue"),
            listOf("MCP", "catalogue", "preset"), listOf("MCP", "import", "review"),
            listOf("MCP", "catalogue", "command"),
        )) {
            val history = views.toMutableList()
            val targets = mutableListOf<NestedBackTarget>()
            for (depth in 1 until views.size) {
                lateinit var target: NestedBackTarget
                target = NestedBackTarget(depth) { history.removeAt(history.lastIndex); targets.remove(target) }
                targets += target
            }
            // Registration order cannot let a reactivated parent swallow the child's Back.
            targets.reverse()
            var leftMcp = false
            for (remaining in views.lastIndex downTo 1) {
                resolveBackTarget(null, targets) { leftMcp = true }!!.invoke()
                assertEquals(views.take(remaining), history)
                assertFalse(leftMcp)
            }
            resolveBackTarget(null, targets) { leftMcp = true }!!.invoke()
            assertTrue(leftMcp)
        }
    }

    @Test fun drawerHasPrecedenceOverNestedAndNavigationBack() {
        var target = ""
        val nested = listOf(NestedBackTarget(1) { target = "nested" })
        resolveBackTarget({ target = "drawer" }, nested) { target = "stack" }!!.invoke()
        assertEquals("drawer", target)
        resolveBackTarget(null, nested) { target = "stack" }!!.invoke()
        assertEquals("nested", target)
        assertNull(resolveBackTarget(null, emptyList(), null))
    }

    @Test fun a6CancelledPredictiveBackDoesNothingCompletedBackCommitsSameTarget() = runBlocking {
        val chat = Destination.Chat("https://backend.example", "p")
        var stack = BackStack(listOf(chat)).push(Destination.ProjectSettings(chat))
        val before = stack
        val arrowBack = resolveBackTarget(null, emptyList()) { stack = stack.back() }
        commitCompletedBack(arrowBack) { flow { emit(0.5f); throw CancellationException("cancel") }.collect { } }
        assertEquals(before, stack)
        commitCompletedBack(arrowBack) { flowOf(0.1f, 0.9f).collect { } }
        assertEquals(listOf(chat), stack.entries)
        assertEquals(before.back(), stack)
    }

    @Test fun cancelledPredictiveBackKeepsTransientFormThenCompletedGestureDismissesIt() = runBlocking {
        var views = listOf("MCP", "catalogue", "preset")
        var navigationPopped = false
        val target = resolveBackTarget(null, listOf(NestedBackTarget(2) { views = views.dropLast(1) })) { navigationPopped = true }
        commitCompletedBack(target) { flow<Unit> { throw CancellationException("cancel") }.collect { } }
        assertEquals(listOf("MCP", "catalogue", "preset"), views)
        commitCompletedBack(target) { flowOf(Unit).collect { } }
        assertEquals(listOf("MCP", "catalogue"), views)
        assertFalse(navigationPopped)
    }
}
