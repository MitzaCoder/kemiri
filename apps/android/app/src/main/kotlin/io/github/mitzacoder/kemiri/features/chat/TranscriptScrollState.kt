package io.github.mitzacoder.kemiri.features.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.github.mitzacoder.kemiri.data.WatchState
import io.github.mitzacoder.kemiri.data.WatchStatus

/** A transcript's position belongs to its live watch, which owns the loaded history. */
internal class TranscriptScrollState {
    var following by mutableStateOf(true)
    private var userScrolled = false
    private var requestedEarlierInGesture = false

    fun latestAnchorIndex(firstPageLoaded: Boolean, lastIndex: Int): Int? =
        lastIndex.takeIf { firstPageLoaded && following && it >= 0 }

    /** Called for nested scroll deltas, not for layout changes or LazyListState scroll commands. */
    fun onScroll(
        userInput: Boolean,
        deltaY: Float,
        consumedY: Float,
        firstVisibleIndex: Int,
        canScrollForward: Boolean,
        watch: WatchState,
        highlighting: Boolean,
    ): Boolean {
        if (deltaY == 0f) return false
        if (userInput) userScrolled = true
        if (!userScrolled || highlighting) return false
        if (consumedY != 0f) following = !canScrollForward

        // Positive Y is a drag toward older rows in this non-reversed list. An unconsumed
        // drag at the boundary counts too, so the user can page even if the latest window fits.
        if (deltaY < 0f || firstVisibleIndex !in 0..6 || requestedEarlierInGesture ||
            watch.status != WatchStatus.Live || !watch.canLoadEarlier || watch.loadingEarlier || watch.earlierError != null
        ) return false
        requestedEarlierInGesture = true
        following = false
        return true
    }

    fun endGesture() {
        userScrolled = false
        requestedEarlierInGesture = false
    }
}
