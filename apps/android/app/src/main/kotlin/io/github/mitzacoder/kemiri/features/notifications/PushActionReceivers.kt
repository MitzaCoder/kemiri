package io.github.mitzacoder.kemiri.features.notifications

import android.app.job.JobParameters
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import io.github.mitzacoder.kemiri.HarnessApplication
import kotlinx.coroutines.*

/** Only a PendingIntent from an active app card can enter this non-exported receiver. */
class PushActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val result = goAsync()
        val app = context.applicationContext as HarnessApplication
        CoroutineScope(Dispatchers.IO).launch {
            try { app.pendingPushActions.receive(intent) }
            finally { result.finish() }
        }
    }
}

class PushActionJobService : JobService() {
    private val jobs = mutableMapOf<Int, Job>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onStartJob(params: JobParameters): Boolean {
        val id = params.extras.getString(PUSH_JOB_ACTION_ID) ?: return false
        jobs[params.jobId] = scope.launch {
            try { withContext(Dispatchers.IO) { (application as HarnessApplication).pendingPushActions.run(id) } }
            finally { if (jobs.remove(params.jobId) != null) jobFinished(params, false) }
        }
        return true
    }


    override fun onStopJob(params: JobParameters): Boolean {
        jobs.remove(params.jobId)?.cancel()
        return false
    }

    override fun onDestroy() { jobs.clear(); scope.cancel(); super.onDestroy() }
}
