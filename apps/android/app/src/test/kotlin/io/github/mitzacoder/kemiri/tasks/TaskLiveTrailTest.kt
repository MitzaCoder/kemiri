package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.protocol.*
import org.junit.Assert.*
import org.junit.Test

class TaskLiveTrailTest {
    private val actor = BoardActivityActor(id = "main:1:run", kind = "worker", name = "fern", threadId = "main", conversationId = 1, runId = "run")
    private fun line(id: String, kind: String = "phase", text: String = "checking $id", minute: Int = id.single().code - 'a'.code) =
        BoardLiveLine(id = id, at = "2026-06-01T12:%02d:00Z".format(minute), kind = kind, text = text, actor = actor)
    private val a = line("a"); private val b = line("b", "result"); private val c = line("c"); private val d = line("d"); private val e = line("e"); private val f = line("f")

    private fun ids(items: List<LiveTrailItem>) = items.map { if (it is LiveTrailItem.Line) it.line.id else "|" }

    @Test fun showsTheNewestThreeNewestFirstAndFoldsTheRest() {
        val trail = liveTrail(listOf(a, b, c, d, e), nowText = null)
        assertEquals(listOf("e", "d", "c"), ids(trail.newest))
        assertEquals(listOf("b", "a"), ids(trail.earlier))
        assertEquals(2, trail.earlierLines)
        assertEquals(0, trail.unseen)
        assertEquals(listOf("b", "a"), ids(liveTrail(listOf(a, b), null).newest))
        assertTrue(liveTrail(listOf(a, b), null).earlier.isEmpty())
        assertTrue(liveTrail(emptyList(), null).newest.isEmpty())
    }

    @Test fun ignoresLineKindsItDoesNotKnow() {
        val future = listOf(a, line("x", "future"), b, line("y", "auto"))
        assertEquals(listOf(a, b), visibleLiveLines(future))
        assertEquals(listOf("b", "a"), ids(liveTrail(future, null).newest))
    }

    @Test fun leavesOutTheNewestPhaseThatNowAlreadyShows() {
        val phase = line("c", text = "checking the balance")
        assertTrue(repeatsNow(phase, "fern is checking the balance"))
        assertTrue(repeatsNow(phase, "fern is  Checking the balance · +2 workers"))
        assertTrue(repeatsNow(phase, "checking the balance"))
        assertFalse(repeatsNow(phase, "fern is checking the balance display"))
        assertFalse(repeatsNow(phase, "fern is checking"))
        assertFalse(repeatsNow(line("c", "result", "checking the balance"), "fern is checking the balance"))
        assertEquals(listOf("b", "a"), ids(liveTrail(listOf(a, b, phase), "fern is checking the balance").newest))
        // Only the newest line can be a repeat; an older phase with the same words stays.
        assertEquals(listOf("c", "b", "a"), ids(liveTrail(listOf(line("a", text = "checking the balance"), b, phase.copy(text = "different")), "fern is checking the balance").newest))
    }

    @Test fun placesTheDividerBelowTheUnseenLines() {
        val all = listOf(a, b, c, d)
        assertEquals(listOf("d", "|", "c", "b"), ids(liveTrail(all, null, setOf("d")).newest))
        assertEquals(listOf("d", "c", "|", "b"), ids(liveTrail(all, null, setOf("c", "d")).newest))
        assertEquals(1, liveTrail(all, null, setOf("d")).unseen)
        assertTrue(liveTrail(all, null, emptySet()).newest.none { it == LiveTrailItem.Divider })
        // Everything is new: the divider closes the list.
        assertEquals(listOf("b", "a", "|"), ids(liveTrail(listOf(a, b), null, setOf("a", "b")).newest))
    }

    @Test fun dividerPastTheNewestThreeMovesIntoEarlier() {
        val all = listOf(a, b, c, d, e, f)
        val three = liveTrail(all, null, setOf("d", "e", "f"))
        assertEquals(listOf("f", "e", "d", "|"), ids(three.newest))
        assertEquals(listOf("c", "b", "a"), ids(three.earlier))
        val five = liveTrail(all, null, setOf("b", "c", "d", "e", "f"))
        assertEquals(listOf("f", "e", "d"), ids(five.newest))
        assertEquals(listOf("c", "b", "|", "a"), ids(five.earlier))
        assertEquals(2, five.earlierUnseen)
        assertEquals(3, five.earlierLines)
    }

    @Test fun aRepeatedPhaseLeavesTheUnseenCountToo() {
        val repeat = line("d", text = "running checks")
        val trail = liveTrail(listOf(a, b, c, repeat), "fern is running checks", setOf("c", "d"))
        assertEquals(listOf("c", "|", "b", "a"), ids(trail.newest))
        assertEquals(1, trail.unseen)
    }

    private class Memory(val saved: MutableMap<String, String> = mutableMapOf()) : LiveSeenStore {
        override fun read(key: String) = saved[key]
        override fun write(key: String, value: String) { saved[key] = value }
    }

    @Test fun checkpointsAdvanceWhileShownButTheDividerWaitsForTheNextVisit() {
        val store = Memory()
        val key = liveSeenKey("local", "bakery", "T1")
        val first = LiveTrailVisit(store, key)
        assertEquals(LiveVisitState(emptySet(), emptySet()), first.update(listOf(a, b)))
        assertEquals(LiveVisitState(setOf("c"), setOf("c")), first.update(listOf(a, b, c)))
        assertEquals(LiveVisitState(setOf("c"), emptySet()), first.update(listOf(a, b, c)))
        assertEquals("""{"id":"c","at":"${c.at}"}""", store.saved[key])
        // A later visit starts at c; another task or project has its own checkpoint.
        assertEquals(setOf("d"), LiveTrailVisit(store, key).update(listOf(a, b, c, d)).unseenIds)
        assertEquals(emptySet<String>(), LiveTrailVisit(store, key).update(listOf(a, b, c, d)).unseenIds)
        assertEquals(emptySet<String>(), LiveTrailVisit(store, liveSeenKey("local", "bakery", "T2")).update(listOf(a, b, c, d)).unseenIds)
        assertNotEquals(key, liveSeenKey("other", "bakery", "T1"))
    }

    @Test fun anEvictedCheckpointCountsLinesNewerThanItsTime() {
        val store = Memory(mutableMapOf("k" to """{"id":"gone","at":"${b.at}"}"""))
        assertEquals(setOf("c", "d"), LiveTrailVisit(store, "k").update(listOf(a, b, c, d)).unseenIds)
        assertEquals(emptySet<String>(), LiveTrailVisit(Memory(mutableMapOf("k" to "not json")), "k").update(emptyList()).unseenIds)
    }

    @Test fun aFoldedSourceDoesNotHighlightEarlierLinesAgain() {
        val visit = LiveTrailVisit(Memory(), "k")
        assertEquals(LiveVisitState(emptySet(), emptySet()), visit.update(emptyList()))
        // With no checkpoint, the first lines of an open empty trail all count as new and arrive.
        assertEquals(LiveVisitState(setOf("a", "b"), setOf("a", "b")), visit.update(listOf(a, b)))
        assertEquals(LiveVisitState(setOf("a"), emptySet()), visit.update(listOf(a)))
    }

    @Test fun nowReplacesTheOlderNowLinesOnlyForAWorkingTaskWithATrail() {
        val sentence = BoardTaskActivity("working", "fern is checking", "2026-06-01T12:00:00Z", emptyList(), ageFormat = "duration")
        val auto = sentence.copy(text = "automatic")
        val working = task("T1", "in_progress").copy(live = BoardTaskLive(listOf(a)), state = BoardTaskState("in_progress", "working", sentence.since, emptyList(), sentence))
        assertEquals(sentence, taskLiveNow(working, true, auto))
        assertEquals(auto, taskLiveNow(working.copy(state = working.state!!.copy(sentence = null)), true, auto))
        assertNull(taskLiveNow(working, false, auto))
        assertNull(taskLiveNow(working.copy(live = null), true, auto))
        assertNull(taskLiveNow(working.copy(live = BoardTaskLive(emptyList())), true, auto))
        assertNull(taskLiveNow(working.copy(state = working.state!!.copy(kind = "paused")), true, auto))
    }

    @Test fun dividerLabelPointsUpAndIsSpokenWithoutTheArrow() {
        assertEquals("↑ New since you looked", LIVE_DIVIDER_LABEL)
        assertEquals("New since you looked: lines above", LIVE_DIVIDER_DESCRIPTION)
    }

    @Test fun aWorkingTaskCanShowLiveBeforeItHasALine() {
        val sentence = BoardTaskActivity("working", "fern is working", a.at, emptyList(), ageFormat = "duration")
        val working = task("T1", "in_progress").copy(state = BoardTaskState("in_progress", "working", a.at, emptyList(), sentence))
        val pulseOnly = working.copy(live = BoardTaskLive(emptyList(), pulse = BoardTaskLivePulse("Reading", "read", a.at)))
        val countersOnly = working.copy(live = BoardTaskLive(emptyList(), counters = BoardTaskLiveCounters(steps = 1, filesChanged = 0, filesSaved = 0, commits = 0, checks = 0)))
        assertEquals(sentence, taskLiveNow(pulseOnly, true, null))
        assertEquals(sentence, taskLiveNow(countersOnly, true, null))
        assertNull(taskLiveNow(pulseOnly, false, null))
        assertNull(taskLiveNow(countersOnly, false, null))
    }

    @Test fun factsAreRecordedNotPhasesOrResultsAndDoNotRepeatNow() {
        val fact = line("c", "fact", "passed a check")
        assertEquals(LiveLineKind.Fact, LiveLineKind.fromWire(fact.kind))
        assertEquals(listOf(a, b, fact), visibleLiveLines(listOf(a, b, fact)))
        assertEquals(listOf("c", "|", "b", "a"), ids(liveTrail(listOf(a, b, fact), "fern is passed a check", setOf("c")).newest))
        assertEquals("Recorded, fern, just now: passed a check", liveLineDescription(LiveLineKind.Fact, fact, "just now"))
        assertEquals("Phase, fern, 3 min ago: checking a", liveLineDescription(LiveLineKind.Phase, a, "3 min ago"))
        assertEquals("Result, fern, just now: checking b", liveLineDescription(LiveLineKind.Result, b, "just now"))
    }

    @Test fun aFinishedRunShowsAsOneWorkRowWithItsLines() {
        val fact = line("c", "fact", "passed a check")
        val label = "fern worked 10 minutes: 2 steps, 1 check"
        val entry = BoardTimelineEntry(at = "2026-06-01T12:10:00Z", kind = "worker", label = label, live =
            BoardTaskLive(listOf(a, b, fact), counters = BoardTaskLiveCounters(steps = 2, filesChanged = 0, filesSaved = 0, commits = 0, checks = 1)))
        val rows = taskActivityRows(ActivitySources(entries = listOf(entry), taskLiveEnabled = true))
        val row = rows.single()
        assertEquals(label, activityText(row.label))
        assertEquals(listOf(a, b, fact), visibleLiveLines(row.live!!.lines))
        assertEquals("live-run:a", row.id)
        assertNull(taskActivityRows(ActivitySources(entries = listOf(entry))).single().live)
    }
}
