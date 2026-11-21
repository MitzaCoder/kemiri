package io.github.mitzacoder.kemiri.chat

import io.github.mitzacoder.kemiri.features.chat.visitCoordinator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class CoordinatorChatStateTest {
    @Test fun returningToAChatPromotesItBeforeEviction() {
        val recents = listOf("general", "shop", "kitchen")
        val returned = visitCoordinator(recents, "general", 3)
        assertEquals(listOf("shop", "kitchen", "general"), returned)
        assertSame(returned, visitCoordinator(returned, "general", 3))
        assertEquals(listOf("kitchen", "general", "deliveries"), visitCoordinator(returned, "deliveries", 3))
    }
}
