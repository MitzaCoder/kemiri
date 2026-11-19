package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.protocol.BoardLivePlanStep

internal enum class LivePlanStepStatus(val label: String) {
    Todo("To do"), Doing("In progress"), Done("Done");

    companion object {
        fun fromWire(status: String): LivePlanStepStatus? = when (status) {
            "todo" -> Todo
            "doing" -> Doing
            "done" -> Done
            else -> null
        }
    }
}

internal data class LivePlanStep(val text: String, val status: LivePlanStepStatus) {
    val description: String get() = "${status.label}: $text"
}

internal data class LivePlan(val steps: List<LivePlanStep>) {
    val progress: String get() = "${steps.count { it.status == LivePlanStepStatus.Done }} of ${steps.size}"
    val description: String get() = "Plan, $progress done"
    val currentStep: LivePlanStep?
        get() = steps.firstOrNull { it.status == LivePlanStepStatus.Doing }
            ?: steps.firstOrNull { it.status == LivePlanStepStatus.Todo }

    fun canFold(foldOnPhone: Boolean): Boolean = foldOnPhone && steps.size > 3

    fun visibleSteps(foldOnPhone: Boolean, expanded: Boolean): List<LivePlanStep> =
        if (canFold(foldOnPhone) && !expanded) listOfNotNull(currentStep) else steps
}

internal fun livePlan(steps: List<BoardLivePlanStep>): LivePlan = LivePlan(steps.mapNotNull { step ->
    LivePlanStepStatus.fromWire(step.status)?.let { LivePlanStep(step.text, it) }
})
