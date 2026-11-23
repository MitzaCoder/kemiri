package io.github.mitzacoder.kemiri.features.notifications

/**
 * The notification kinds in the protocol's order with the web's words for them (web `lib/notifications.ts`
 * `NOTIFICATION_KIND_INFO`, client `NOTIFICATION_KINDS`), and the defaults history a stored device migrates through
 * (client `DEFAULT_KINDS_BY_VERSION`).
 */
data class NotificationKindInfo(val kind: String, val label: String, val description: String, val failure: Boolean)

val NOTIFICATION_KIND_INFO: List<NotificationKindInfo> = listOf(
    NotificationKindInfo("reply", "Main chat replies", "An answer finished while you were away.", false),
    NotificationKindInfo("worker_report", "Worker reports", "A worker finished its task and reported. Off by default: Work finished covers a long run.", false),
    NotificationKindInfo("worker_failed", "Worker failures", "A worker failed or stopped without reporting.", true),
    NotificationKindInfo("schedule_done", "Scheduled runs", "A scheduled task started or finished.", false),
    NotificationKindInfo("schedule_problem", "Schedule problems", "A scheduled run failed or was skipped.", true),
    NotificationKindInfo("deploy_problem", "Deploy problems", "A deploy failed or rolled back.", true),
    NotificationKindInfo("login_prompt", "Login prompts", "A provider login waits for a code or a decision.", false),
    NotificationKindInfo("usage_limit_reached", "Subscription limits", "A subscription reached its limit and work is waiting.", false),
    NotificationKindInfo("compaction_failed", "Compaction failures", "Summarizing a long conversation failed.", true),
    NotificationKindInfo("maintenance_failed", "Maintenance failures", "A nightly memory maintenance run failed.", true),
    NotificationKindInfo("board_question", "Board questions", "Main or a background job asked you something on the board.", false),
    NotificationKindInfo("thread_finished", "Background work finished", "A background job finished; opens its card in Main chat.", false),
    NotificationKindInfo("thread_failed", "Background work failed", "A background job failed; opens its card in Main chat.", true),
    NotificationKindInfo("coordinator_failed", "Coordinator failures", "A coordinator turn failed; opens its chat.", true),
    NotificationKindInfo("work_finished", "Work finished", "One notification when a project goes quiet.", false),
    NotificationKindInfo("disk_low", "Low disk space", "A computer's disk is running low.", true),
    NotificationKindInfo("task_review", "Tasks ready for review", "A task is ready for you to look at; opens the task.", false),
    NotificationKindInfo("task_steps", "Tasks with steps for me", "A task has manual steps for you to do; opens the task.", false),
)

val NOTIFICATION_KINDS: List<String> = NOTIFICATION_KIND_INFO.map { it.kind }

fun kindInfo(kind: String): NotificationKindInfo? = NOTIFICATION_KIND_INFO.firstOrNull { it.kind == kind }

/** A kind that reports something going wrong; quiet hours may still let these through. */
fun isNotificationFailure(kind: String): Boolean = kindInfo(kind)?.failure == true

/** What a new device started with, by defaults version (the index); the last is protocol `DEFAULT_NOTIFICATION_KINDS`. */
private val DEFAULT_KINDS_BY_VERSION: List<List<String>> = listOf(
    listOf("reply", "worker_report", "worker_failed", "schedule_problem", "deploy_problem", "login_prompt"),
    listOf("reply", "worker_report", "worker_failed", "schedule_problem", "deploy_problem", "login_prompt", "board_question"),
    listOf("reply", "worker_report", "worker_failed", "schedule_problem", "deploy_problem", "login_prompt", "board_question", "thread_finished", "thread_failed"),
    listOf("reply", "worker_failed", "schedule_problem", "deploy_problem", "login_prompt", "board_question", "thread_finished", "thread_failed", "work_finished", "disk_low"),
    listOf("reply", "worker_failed", "schedule_problem", "deploy_problem", "login_prompt", "board_question", "thread_finished", "thread_failed", "work_finished", "disk_low", "task_review"),
    listOf("reply", "worker_failed", "schedule_problem", "deploy_problem", "login_prompt", "board_question", "thread_finished", "thread_failed", "coordinator_failed", "work_finished", "disk_low", "task_review"),
    listOf("reply", "worker_failed", "schedule_problem", "deploy_problem", "login_prompt", "board_question", "thread_finished", "thread_failed", "coordinator_failed", "work_finished", "disk_low", "task_review", "task_steps"),
    listOf("reply", "worker_failed", "schedule_problem", "deploy_problem", "login_prompt", "usage_limit_reached", "board_question", "thread_finished", "thread_failed", "coordinator_failed", "work_finished", "disk_low", "task_review", "task_steps"),
)

/** The defaults version this build writes. */
val NOTIFICATION_DEFAULTS_VERSION: Int = DEFAULT_KINDS_BY_VERSION.size - 1

/** What a device starts with, which "Reset" restores. */
val DEFAULT_NOTIFICATION_KINDS: List<String> = DEFAULT_KINDS_BY_VERSION.last()

/**
 * The kinds a device has after the defaults moved on: each version it missed replaces its kinds when they were exactly
 * that version's defaults. A device that customised its kinds is left alone.
 */
fun migrateDefaultKinds(kinds: List<String>, fromVersion: Int): List<String> {
    var current = kinds
    for (version in maxOf(0, fromVersion) until NOTIFICATION_DEFAULTS_VERSION) {
        val before = DEFAULT_KINDS_BY_VERSION[version]
        val after = DEFAULT_KINDS_BY_VERSION[version + 1]
        if (current.size == before.size && before.all { it in current }) current = NOTIFICATION_KINDS.filter { it in after }
    }
    return current
}

/** Turn one kind on or off, keeping the protocol's order. */
fun withKind(kinds: List<String>, kind: String, on: Boolean): List<String> {
    val next = kinds.toMutableSet().apply { if (on) add(kind) else remove(kind) }
    return NOTIFICATION_KINDS.filter { it in next }
}

fun kindsSummary(kinds: List<String>): String = when (kinds.size) {
    0 -> "No events"
    NOTIFICATION_KINDS.size -> "Every event"
    else -> "${kinds.size} of ${NOTIFICATION_KINDS.size} events"
}

internal val NOTIFICATION_ALERT_GROUPS = linkedMapOf(
    "Subscription" to listOf("usage_limit_reached"),
    "Needs you" to listOf("login_prompt", "board_question", "task_review", "task_steps"),
    "Work finished" to listOf("reply", "worker_report", "work_finished", "thread_finished", "schedule_done"),
    "Problems" to listOf("worker_failed", "schedule_problem", "deploy_problem", "thread_failed", "coordinator_failed", "disk_low", "compaction_failed", "maintenance_failed"),
)

internal enum class NotificationPreset(val label: String, val kinds: List<String>?) {
    Important("Important", DEFAULT_NOTIFICATION_KINDS),
    Needed("Only when I'm needed", NOTIFICATION_KINDS.filter { it in NOTIFICATION_ALERT_GROUPS.getValue("Needs you") || isNotificationFailure(it) }),
    Everything("Everything", NOTIFICATION_KINDS),
    Custom("Custom", null),
}

internal fun notificationPreset(kinds: List<String>): NotificationPreset {
    val set = kinds.toSet()
    return NotificationPreset.entries.firstOrNull { it.kinds?.toSet() == set } ?: NotificationPreset.Custom
}
