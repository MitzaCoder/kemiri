package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.liveCounterLabels
import io.github.mitzacoder.kemiri.features.tasks.livePulseDescription
import io.github.mitzacoder.kemiri.features.tasks.pulseElapsed
import io.github.mitzacoder.kemiri.protocol.BoardTaskLiveCounters
import io.github.mitzacoder.kemiri.protocol.BoardTaskLivePulse
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class TaskLiveRunTest {
    private val started = Instant.parse("2026-06-01T12:00:00Z")

    @Test fun elapsedRoundsDownAndSwitchesFromSecondsToMinutes() {
        assertEquals("0 s", pulseElapsed(started.toString(), started.minusMillis(500)))
        assertEquals("0 s", pulseElapsed(started.toString(), started))
        assertEquals("1 s", pulseElapsed(started.toString(), started.plusMillis(1999)))
        assertEquals("59 s", pulseElapsed(started.toString(), started.plusMillis(59_999)))
        assertEquals("1 min", pulseElapsed(started.toString(), started.plusSeconds(60)))
        assertEquals("2 min", pulseElapsed(started.toString(), started.plusSeconds(121)))
        assertNull(pulseElapsed("not a date", started))
    }

    @Test fun pulseDescriptionUsesTheServerLabelAndOmitsMissingDetails() {
        val pulse = BoardTaskLivePulse(label = "Verify gift card payments", tool = "bash", since = started.toString())
        assertEquals("Run pulse: Verify gift card payments, bash, 2 s", livePulseDescription(pulse, "2 s"))
        assertEquals("Run pulse: Running a command", livePulseDescription(pulse.copy(label = "Running a command", tool = null), null))
    }

    @Test fun countersOmitZeroAndKeepTheWebOrderAndPlurals() {
        val empty = BoardTaskLiveCounters(steps = 0, filesChanged = 0, filesSaved = 0, commits = 0, checks = 0)
        assertEquals(emptyList<String>(), liveCounterLabels(null))
        assertEquals(emptyList<String>(), liveCounterLabels(empty))
        assertEquals(listOf("1 step", "2 files changed", "1 file saved", "3 commits", "1 check"),
            liveCounterLabels(empty.copy(steps = 1, filesChanged = 2, filesSaved = 1, commits = 3, checks = 1)))
        assertEquals(listOf("2 steps", "1 file changed", "2 files saved", "1 commit", "2 checks"),
            liveCounterLabels(empty.copy(steps = 2, filesChanged = 1, filesSaved = 2, commits = 1, checks = 2)))
        assertEquals(listOf("1 commit", "2 checks"), liveCounterLabels(empty.copy(commits = 1, checks = 2)))
    }
}
