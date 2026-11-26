package io.github.mitzacoder.kemiri

import io.github.mitzacoder.kemiri.data.WatchState
import io.github.mitzacoder.kemiri.data.WatchStatus
import io.github.mitzacoder.kemiri.features.chat.TranscriptScrollState
import org.junit.Assert.*
import org.junit.Test

class TranscriptScrollStateTest {
    private val live = WatchState(status = WatchStatus.Live, canLoadEarlier = true)

    private fun TranscriptScrollState.scroll(
        userInput: Boolean = true,
        deltaY: Float = 20f,
        consumedY: Float = deltaY,
        index: Int = 0,
        canScrollForward: Boolean = true,
        watch: WatchState = live,
        highlighting: Boolean = false,
    ) = onScroll(userInput, deltaY, consumedY, index, canScrollForward, watch, highlighting)

    @Test fun freshProjectAnchorsAtLatestAfterItsFirstPageWithoutPaging() {
        val harbor = TranscriptScrollState()
        assertTrue(harbor.scroll(index = 6))
        assertNull(harbor.latestAnchorIndex(firstPageLoaded = true, lastIndex = 50))

        val orchard = TranscriptScrollState()
        assertNull(orchard.latestAnchorIndex(firstPageLoaded = false, lastIndex = 0))
        // The first page fits and the first visible index still reports zero. Neither
        // that layout nor programmatic motion is a request to page back.
        assertFalse(orchard.scroll(userInput = false, consumedY = 0f, canScrollForward = false))
        assertEquals(1, orchard.latestAnchorIndex(firstPageLoaded = true, lastIndex = 1))
        assertFalse(orchard.scroll(userInput = false))
        assertEquals(50, orchard.latestAnchorIndex(firstPageLoaded = true, lastIndex = 50))
        assertNull(harbor.latestAnchorIndex(firstPageLoaded = true, lastIndex = 50))
    }

    @Test fun onlyOnePagePerGestureEvenWhenThePrependLeavesTheReaderNearTheBoundary() {
        val transcript = TranscriptScrollState()
        assertFalse(transcript.scroll(index = 7))
        assertTrue(transcript.scroll(userInput = false, index = 6)) // Fling from the user's drag.
        assertFalse(transcript.scroll(userInput = false))
        assertFalse(transcript.scroll())
        assertNull(transcript.latestAnchorIndex(firstPageLoaded = true, lastIndex = 100))
        transcript.endGesture()
        assertFalse(transcript.scroll(userInput = false))
        assertTrue(transcript.scroll(consumedY = 0f, canScrollForward = false))
    }

    @Test fun noPagingTowardLatestOrWhileHistoryIsUnavailable() {
        val transcript = TranscriptScrollState()
        assertFalse(transcript.scroll(deltaY = -20f, canScrollForward = false))
        assertTrue(transcript.following)
        assertFalse(transcript.scroll(watch = live.copy(status = WatchStatus.Reconnecting)))
        assertFalse(transcript.scroll(watch = live.copy(canLoadEarlier = false)))
        assertFalse(transcript.scroll(watch = live.copy(loadingEarlier = true)))
        assertFalse(transcript.scroll(watch = live.copy(earlierError = "Retry")))
        assertFalse(transcript.scroll(highlighting = true))
        assertTrue(transcript.scroll())
    }
}
