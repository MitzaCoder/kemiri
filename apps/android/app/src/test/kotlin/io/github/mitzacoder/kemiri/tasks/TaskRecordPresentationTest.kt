package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.data.taskTimelineRequest
import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset

class TaskRecordPresentationTest {
    private val asked = "2026-04-09T12:00:00Z"
    private val answered = "2026-04-10T14:00:00Z"
    private val later = "2026-04-10T15:00:00Z"
    private val user = BoardWriter("user", null, null)
    private fun answer(id: String) = question(id, "T1", status = "answered").copy(
        text = "How long should we keep it?", answer = "Three days", askedAt = asked, answeredAt = answered,
    )
    private fun decision(id: String, why: String?) = BoardDecision(id, "Keep the reservation for three days", why, "T1", at = answered)

    @Test fun pairsExplicitCitationsAndKeepsTheIndependentReasonOrRow() {
        val choices = listOf(answer("Q1"), answer("Q2"), answer("Q3"))
        val decisions = listOf(decision("D1", "Answer to `q1`: Three days"),
            decision("D2", "Use the current policy").copy(text = "Reply to question Q2: Do not accept payment"), decision("D3", null))
        val rows = taskDecided("T1", decisions, choices)
        assertEquals(listOf(Triple("D1", "Q1", null), Triple("D2", "Q2", "Use the current policy"),
            Triple("D3", null, null), Triple("Q3", "Q3", null)), rows.map { Triple(it.id, it.question?.id, it.why) })
    }

    @Test fun ignoresBareMentionsAmbiguityOtherTasksAndDecisionsOlderThanTheAnswer() {
        val questions = listOf(answer("Q1"), answer("Q11"), answer("Q2").copy(taskId = "T2"),
            answer("Q3").copy(status = "open"), answer("Q4").copy(kind = "warning"), answer("Q5"), answer("Q6"))
        val decisions = listOf(decision("D1", "Wait for Q1"), decision("D2", "Answer to Q2"), decision("D3", "Answer to Q3"),
            decision("D4", "Answer to Q4"), decision("D5", "Answer to Q5 and Q6"), decision("D6", "Answer to Q11").copy(at = asked),
            decision("D7", "Answer to Q6"), decision("D8", "Answer to Q6"),
            decision("D9", "Answer to Q1").copy(text = "Reply to Q11"))
        val rows = taskDecided("T1", decisions, questions)
        assertTrue(rows.none { it.decision != null && it.question != null })
        assertEquals(listOf("Q1", "Q11", "Q5", "Q6"), rows.filter { it.question != null }.map { it.id })
    }

    @Test fun mergesLegacyWorkerEpisodesAndSnapshotsAndOmitsFactsShownElsewhere() {
        val snapshot = BoardTaskSnapshot(1, later, "in_progress → review", user, "Task", "review", report = BoardTaskSnapshotReport("", "", ""))
        val entries = listOf(
            BoardTimelineEntry(later, "status", snapshot.label, ref = "1"),
            BoardTimelineEntry(asked, "question", "Question Q1"),
            BoardTimelineEntry(answered, "question", "Q2 answered", ref = "Q2"),
            BoardTimelineEntry(answered, "decision", "Decision D1", ref = "D1"),
            BoardTimelineEntry(asked, "worker", "Worker demo started", ref = "demo"),
            BoardTimelineEntry(answered, "worker", "Worker demo reported", ref = "demo", detail = "Checked the work"),
            BoardTimelineEntry(answered, "worker", "Worker demo reported", ref = "demo", detail = "Checked the work"),
            BoardTimelineEntry(answered, "milestone", "1 change landed on main", detail = "Landed b4a1e00bad01 Add it"),
        )
        val rows = taskActivityRows(ActivitySources(entries, snapshots = listOf(snapshot), questions = listOf(answer("Q1").copy(status = "open"), answer("Q2")),
            decisions = taskDecided("T1", listOf(decision("D1", "Answer to Q2")), listOf(answer("Q2"))),
            workers = mapOf("demo" to null, "forgotten" to null), now = ActivityNow("Checked the work", later), deliveryShown = true))
        assertEquals(listOf("Working → review", "Worker demo reported", "forgotten · worker no longer available"), rows.map { it.label })
        assertEquals(snapshot, rows.first().snapshot)
        assertEquals(answered, rows[1].at)
        val now = Instant.parse(later).toEpochMilli()
        assertEquals(listOf(later), activityDays(rows, true, 1, now, ZoneOffset.UTC).first().entries.map { it.at })
        assertEquals(listOf(answered, later), activityDays(rows, false, 2, now, ZoneOffset.UTC).first().entries.map { it.at })
        assertEquals(listOf("Today", "Date not recorded"), activityDays(rows, true, 3, now, ZoneOffset.UTC).map { it.day })
        assertEquals("Deployed the commit", activityText("Deployed `b4a1e00bad01`"))
        assertTrue(isDeliveryMilestone(entries.last()))
        assertFalse(isDeliveryMilestone(entries.last().copy(detail = "Talked about a commit")))
        assertTrue(taskActivityRows(ActivitySources(entries = listOf(entries.last()))).isNotEmpty())
    }

    @Test fun groupedEpisodesUseOutcomeTimeAndAbsorbNowForTheSameRunningActor() {
        val actor = BoardActivityActor("run-a", "worker", "demo", threadId = "main", conversationId = 2, runId = "run-a")
        val fact = BoardTimelineFact(asked, "worker", "Worker started", id = "worker-run", endAt = answered, revision = 1,
            group = "work", outcome = "running", factCount = 1, actor = actor)
        val group = BoardTimelineGroup("group", "work", asked, BoardTimelineGroupRange(asked, answered), 1, 1, "Worker started", listOf(fact))
        val sources = ActivitySources(groups = listOf(group), entries = listOf(BoardTimelineEntry(asked, "worker", "Worker demo started", ref = "demo")),
            workers = mapOf("demo" to null))
        assertEquals(answered, taskActivityRows(sources).single().at)
        val now = ActivityNow("Demo is checking the work", later, BoardTaskActivity("working", "Demo is checking the work", later, listOf(actor.id), actor = actor))
        val row = taskActivityRows(sources.copy(now = now)).single()
        assertEquals("worker-run", row.id)
        assertEquals(later, row.at)
        assertEquals(now.text, row.label)
        assertTrue(row.now)
    }

    @Test fun hidesNowWhenItRepeatsAnOpenQuestionOrProjectedDelivery() {
        val task = task("T1", "in_progress")
        val work = BoardTaskActivity("working", "Checking the work", later, listOf("Q1"))
        val open = listOf(answer("Q1").copy(status = "open"))
        assertNull(taskRecordNow(task, work, open, false))
        assertNull(taskRecordNow(task, work.copy(kind = "deploy"), emptyList(), true))
        assertNotNull(taskRecordNow(task, work.copy(kind = "deploy"), emptyList(), false))
        assertEquals(ActivityNow("Legacy prose", task.updatedAt), taskRecordNow(task.copy(report = task.report.copy(now = "Legacy prose")), null, emptyList(), false))
    }

    @Test fun deliveryShowsOnlyObservedSuccessAndOmitsCommitsFromSummary() {
        fun steps(delivery: BoardTaskTimelineResponseDelivery?) = deliverySteps(delivery)
        assertTrue(steps(null).isEmpty())
        assertTrue(steps(BoardTaskTimelineResponseDelivery(emptyList(), deployment = "live")).isEmpty())
        val built = BoardTaskTimelineResponseDelivery(listOf("b4a1e00bad01", "c4a1e00bad02"))
        assertEquals(listOf(DeliveryStep("Built", "2 commits", true), DeliveryStep("Merged", "Not observed", false),
            DeliveryStep("Live", "Not observed", false)), steps(built))
        val integration = BoardTaskTimelineResponseDeliveryIntegration("refs/heads/main", 1)
        assertEquals(DeliveryStep("Merged", "1 of 2 on the integration ref", false), steps(built.copy(integration = integration))[1])
        assertEquals(listOf(DeliveryStep("Built", "2 commits", true), DeliveryStep("Merged", "On main", true), DeliveryStep("Live", "Deploy succeeded", true)),
            steps(built.copy(integration = integration.copy(landed = 2), deployment = "live")))
        for ((state, label) in mapOf("pending" to "Not fully live", "failed" to "Deploy failed", "unknown" to "Status unknown")) {
            assertEquals(DeliveryStep("Live", label, false), steps(built.copy(deployment = state)).last())
        }
    }

    @Test fun wireRequestOmitsDeliveryOnLegacyReadsAndRequestsItOnSupportedReads() {
        fun json(delivery: Boolean) = wireJson.encodeToJsonElement(BoardTaskTimelineRequest.serializer(),
            taskTimelineRequest("project-demo", "T1", null, grouped = true, delivery = delivery)).jsonObject
        assertEquals(null, json(false)["delivery"])
        assertEquals(JsonPrimitive(true), json(true)["delivery"])
    }
}
