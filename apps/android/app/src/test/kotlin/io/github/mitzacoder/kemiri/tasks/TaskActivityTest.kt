package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.protocol.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class TaskActivityTest {
    private val now = Instant.parse("2026-01-01T12:00:00Z").toEpochMilli()
    private val activity = BoardTaskActivity("working", "fern is testing the card view", "2026-01-01T11:56:00Z", emptyList())
    private val report = BoardTaskReport(now = "Legacy prose", results = "Results", next = "Next", revision = 1, updatedAt = null, updatedBy = null)

    @Test fun featureAndFieldAreBothRequired() {
        val task = task("T1", report = report).copy(activity = activity)
        assertEquals(activity, taskActivity(task, true))
        assertNull(taskActivity(task, false))
        assertNull(taskActivity(task.copy(activity = null), true))
        assertEquals(activity.text, taskNowText(task, true))
        assertEquals("Legacy prose", taskNowText(task, false))
        assertEquals("Legacy prose", taskNowText(task.copy(activity = null), true))
    }
    @Test fun serverSentenceAndDurationAges() {
        val sentence = activity.copy(text = "Paused", ageFormat = "duration", agePrefix = " · nothing has run on it for ")
        val task = task("T1").copy(state = BoardTaskState("in_progress", "paused", activity.since, emptyList(), sentence))
        assertEquals(sentence, taskRowActivity(task, true))
        assertEquals("4 min", activityAge(sentence, now))
        assertEquals("5 min", activityAge(sentence, now + 30000))
        assertEquals("3 h", activityAge(sentence, now + 146 * 60000))
        assertEquals("3 h", activityAge(sentence, now + 3 * 3600000))
        assertEquals("45 d", activityAge(sentence, now + 45L * 86400000))
        assertEquals("Paused · nothing has run on it for 4 min", activityDescription(sentence, now))
        assertEquals("", activityAge(sentence.copy(ageFormat = "none"), now))
        assertEquals("", activityAge(sentence.copy(since = "invalid"), now))
        assertEquals("Paused", taskRowActivity(task.copy(state = task.state!!.copy(sentence = null)), true)?.text)
    }
    @Test fun ageTicksWithoutChangingCanonicalText() {
        assertEquals("4 min ago", activityAge(activity, now))
        assertEquals("5 min ago", activityAge(activity, now + 60000))
        assertEquals("fern is testing the card view · 4 min ago", activityDescription(activity, now))
        assertEquals("fern is testing the card view", activity.text)
    }
    @Test fun invalidFutureAndEmbeddedSinceAreCalm() {
        assertEquals("", activityAge(activity.copy(since = "invalid"), now))
        assertEquals("just now", activityAge(activity.copy(since = "2026-01-01T13:00:00Z"), now))
        assertEquals("", activityAge(activity.copy(text = "Done since 14:17"), now))
    }
    @Test fun allKindsHaveATone() {
        assertEquals(ActivityTone.Error, activityTone("failure"))
        for (kind in listOf("question", "feedback", "blocked", "waiting")) assertEquals(ActivityTone.Attention, activityTone(kind))
        for (kind in listOf("working", "deploy")) assertEquals(ActivityTone.Active, activityTone(kind))
        assertEquals(ActivityTone.Review, activityTone("review"))
        for (kind in listOf("idle", "done", "dropped", "not_started", "unknown", "delivery", "future_kind")) assertEquals(ActivityTone.Muted, activityTone(kind))
    }
    @Test fun gistsUseCanonicalActivityAndKeepLegacyFallback() {
        val task = task("T1", "review", report = report).copy(activity = activity)
        val row = TaskRow(task, emptyList(), TaskSectionId.Review)
        assertEquals("Results", rowGist(row))
        assertEquals(activity.text, rowGist(row, true))
    }
}
