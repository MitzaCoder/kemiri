package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.protocol.BoardTaskActivity
import io.github.mitzacoder.kemiri.protocol.BoardQuestionChoice
import io.github.mitzacoder.kemiri.protocol.BoardReportCheck
import java.io.File
import org.junit.Assert.*
import org.junit.Test

class TaskDetailsTest {
    private val question = question("Q1", "T1", "question")

    @Test fun needsYouShowsOpenOwnerQuestionsAndWarningsForThisTask() {
        val warning = question.copy(id = "Q2", kind = "warning")
        val forAgent = question.copy(id = "Q3", waitingOn = "agent")
        val working = task("T1", "in_progress")
        val needs = taskNeedsYou(working, listOf(question, warning, forAgent,
            question.copy(id = "Q4", status = "answered"), question.copy(id = "Q5", taskId = "T2")), false, stepsSupported = false)
        assertEquals(listOf(warning, question), needs.ownerQuestions)
        assertEquals(listOf(forAgent), needs.questionsForAgent)
        assertTrue(needs.show)
        assertEquals("Needs your answer", taskDetailState(working.status, needs))
        assertFalse(taskNeedsYou(working, listOf(forAgent), false, stepsSupported = false).show)
        assertEquals("Working", taskDetailState(working.status, taskNeedsYou(working, listOf(warning), false, stepsSupported = false)))
    }

    @Test fun reviewAlwaysShowsCheckAndBlockedTaskNeedsReasonOrBlocker() {
        fun needs(status: String, reason: String? = null, blockers: Boolean = false) =
            taskNeedsYou(task("T1", status, blockedReason = reason), emptyList(), blockers, stepsSupported = false)
        assertEquals(TaskNeedsYou(emptyList(), emptyList(), review = true, blocked = false), needs("review"))
        assertTrue(needs("review").show)
        assertTrue(needs("blocked", "Waiting for a part").blocked)
        assertTrue(needs("blocked", blockers = true).show)
        assertFalse(needs("blocked", " ").show)
        assertFalse(needs("done", "Old reason", true).show)
    }

    @Test fun taskStateIsInWordsWithoutAnOwnerQuestion() {
        for ((status, label) in listOf("todo" to "To do", "in_progress" to "Working", "review" to "Ready for you to check",
            "blocked" to "Blocked", "waiting" to "Waiting", "done" to "Done", "dropped" to "Dropped")) {
            val needs = taskNeedsYou(task("T1", status), emptyList(), false, stepsSupported = false)
            assertEquals(status == "review", needs.show)
            assertEquals(label, taskDetailState(status, needs))
        }
    }

    @Test fun manualStepsRequireTheFeatureAndAnOpenTaskAndDoNotReplaceTheReviewCheck() {
        val markdown = "1. Print the **Reserve a book** sign.\n2. Put it by the till."
        val task = task("T1", "todo").let { it.copy(report = it.report.copy(steps = markdown, stepsWrittenAt = it.updatedAt)) }
        fun needs(status: String, enabled: Boolean = true) =
            taskNeedsYou(task.copy(status = status), emptyList(), false, enabled)
        assertFalse(needs("todo", enabled = false).show)
        assertFalse(needs("done").show)
        assertFalse(needs("dropped").show)
        assertFalse(taskNeedsYou(task.copy(report = task.report.copy(steps = " ")), emptyList(), false, true).show)
        assertTrue(needs("todo").show)
        assertTrue(needs("todo").showSteps)
        assertTrue(needs("review").showSteps)
        assertTrue(needs("review").review)
        assertEquals("Your steps to do", taskDetailState("todo", needs("todo"), "steps_needed"))
        assertEquals("Your steps to do", taskDetailState("todo", needs("todo")))
        assertEquals("Failed", taskDetailState("todo", needs("todo"), "failed"))
        assertEquals("To do", taskDetailState("todo", needs("todo", enabled = false), "steps_needed"))
        val withQuestion = taskNeedsYou(task, listOf(question), false, true)
        assertEquals("Needs your answer", taskDetailState("todo", withQuestion, "answer_needed"))
    }

    @Test fun onlyWorkingTasksShowNowAndOnlyForWorkActivityOrLegacyProse() {
        val working = task("T1", "in_progress")
        val legacy = working.copy(report = working.report.copy(now = "Checking the till"))
        val activity = BoardTaskActivity("working", "Checking the till", "2026-01-01T00:00:00Z", emptyList())
        for (kind in listOf("working", "deploy", "idle", "unknown")) assertTrue(showTaskNow(working, activity.copy(kind = kind)))
        assertFalse(showTaskNow(legacy, activity.copy(kind = "question")))
        assertFalse(showTaskNow(working.copy(status = "review"), activity))
        assertTrue(showTaskNow(legacy, null))
        assertFalse(showTaskNow(working, null))
    }

    @Test fun structuredDetailsRequireTheFeatureAndPopulatedFieldsWithoutChangingMarkdown() {
        val task = task("T1")
        val legacy = task.report.copy(results = "- Legacy result", next = "**Legacy plan**")
        val passed = BoardReportCheck("Tests", "passed", count = 0, at = task.createdAt)
        val failed = BoardReportCheck("Typecheck", "failed", at = task.createdAt)
        val structuredNotDone = " No reminders yet. \r\n\r\n* **Staff edits** are not ready.\n1. No email."
        val populated = task.copy(goal = " Reserve books. ", report = legacy.copy(summary = " The form is ready. ",
            notDone = structuredNotDone, checks = listOf(passed, failed)))
        assertEquals(TaskDetailFields(), taskDetailFields(populated, false))
        assertEquals(TaskDetailFields(), taskDetailFields(task.copy(report = legacy), true))
        assertEquals(TaskDetailFields(), taskDetailFields(task.copy(goal = null, report = legacy.copy(summary = " ", notDone = "\n \t \n", checks = emptyList())), true))
        assertEquals(TaskDetailFields("Reserve books.", true, true, listOf(passed, failed),
            summary = "The form is ready.", notDoneMarkdown = "- No reminders yet.\n- **Staff edits** are not ready.\n- No email."),
            taskDetailFields(populated, true))
        assertEquals(TaskDetailFields(showNotDone = true, notDoneMarkdown = "- Just one item."), taskDetailFields(task.copy(goal = " ", report = legacy.copy(notDone = "Just one item.")), true))
        assertEquals(legacy.results, populated.report.results)
        assertEquals(legacy.next, populated.report.next)
    }

    @Test fun failureLineNamesOnlyFailedChecks() {
        val passed = BoardReportCheck("Tests", "passed", count = 0, at = question.askedAt)
        val failed = BoardReportCheck("Typecheck", "failed", at = question.askedAt)
        assertNull(failedCheckLine(emptyList()))
        assertNull(failedCheckLine(listOf(passed)))
        assertEquals("One check failed: Typecheck", failedCheckLine(listOf(passed, failed)))
        assertEquals("2 checks failed: Typecheck, Build", failedCheckLine(listOf(failed, passed, failed.copy(name = "Build"))))
    }

    @Test fun questionChoicesPreserveTheAnswerLabelAndFallBackToOptions() {
        val options = listOf("**Now**", "Later")
        val choices = listOf(BoardQuestionChoice("**Now**", "Books go on sale today.", recommended = true), BoardQuestionChoice("Later"))
        val legacy = question.copy(options = options)
        val structured = legacy.copy(choices = choices)
        val answers = questionAnswers(structured, true) as QuestionAnswers.Choices
        assertEquals(choices, answers.choices)
        assertEquals("**Now**", answers.choices.first().label)
        assertEquals(QuestionAnswers.Options(options), questionAnswers(structured, false))
        assertEquals(QuestionAnswers.Options(options), questionAnswers(legacy, true))
        assertEquals(QuestionAnswers.Options(options), questionAnswers(structured.copy(choices = emptyList()), true))
        assertEquals(QuestionAnswers.Options(emptyList()), questionAnswers(structured.copy(kind = "warning"), true))
    }

    @Test fun filesShowsTheFullTaskFeedWithoutADisclosureAfterResults() {
        val tasks = File("src/main/kotlin/io/github/mitzacoder/kemiri/features/tasks")
        val classic = tasks.resolve("ClassicTaskView.kt").readText()
        val sectionsAfterResults = classic.substringAfter("item(key = \"results\")").substringBefore("item(key = \"record\")")
        assertTrue(Regex("""TaskReadingSection\("Files"\) \{\s*TaskFiles\(context, artifacts, onUpdateTags""").containsMatchIn(sectionsAfterResults))
        assertTrue(tasks.resolve("TaskSheetState.kt").readText().contains("ArtifactsListRequest(projectId = project, taskId = taskId)"))
        assertFalse(tasks.resolve("TaskAbout.kt").readText().contains("TaskFiles("))
    }

    @Test fun requestStartsOpenAndRowsRememberTheirChoicesIndependently() {
        val empty = emptyMap<String, Boolean>()
        assertEquals(listOf(TaskRecordRow.Request, TaskRecordRow.Checks, TaskRecordRow.Decided, TaskRecordRow.Activity), TaskRecordRow.entries)
        assertTrue(readTaskRecordFold(TaskRecordRow.Request, empty))
        assertFalse(readTaskRecordFold(TaskRecordRow.Decided, empty))
        assertFalse(readTaskRecordFold(TaskRecordRow.Activity, empty))
        assertFalse(readTaskRecordFold(TaskRecordRow.Checks, empty))
        val basicFolds = saveTaskRecordFold(TaskRecordRow.Activity, true, saveTaskRecordFold(TaskRecordRow.Request, false, empty))
        val saved = saveTaskRecordFold(TaskRecordRow.Checks, true, basicFolds)
        assertTrue(readTaskRecordFold(TaskRecordRow.Checks, saved))
        assertFalse(readTaskRecordFold(TaskRecordRow.Request, saved))
        assertFalse(readTaskRecordFold(TaskRecordRow.Decided, saved))
        assertTrue(readTaskRecordFold(TaskRecordRow.Activity, saved))
    }

    @Test fun doneWhenMakesAListOutOfSeparatedCriteriaButNotASingleSentence() {
        assertEquals("- Reserve a book\n- get an email", acceptanceMarkdown("Reserve a book; get an email;"))
        assertEquals("- Reserve a book\n- Get an email", acceptanceMarkdown("Reserve a book\r\nGet an email"))
        assertEquals("Reserve a book.", acceptanceMarkdown("Reserve a book."))
    }

    @Test fun doneWhenKeepsMarkdownBlocksAndInlineTokens() {
        val list = "1. Reserve a book; check stock\n2. Get an email"
        assertEquals(list, acceptanceMarkdown(list))
        val paragraphs = "First paragraph.\n\nSecond paragraph."
        assertEquals(paragraphs, acceptanceMarkdown(paragraphs))
        assertEquals("- Show `a;b`\n- visit [a;b](https://example.com/a;b)\n- finish",
            acceptanceMarkdown("Show `a;b`; visit [a;b](https://example.com/a;b); finish"))
        assertEquals("- Visit https://example.com/a;b\n- show x &amp; y\n- escape a\\;b",
            acceptanceMarkdown("Visit https://example.com/a;b; show x &amp; y; escape a\\;b"))
    }
}
