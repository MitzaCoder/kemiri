package io.github.mitzacoder.kemiri.features.notifications

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import io.github.mitzacoder.kemiri.HarnessApplication
import io.github.mitzacoder.kemiri.data.BackendConfig
import io.github.mitzacoder.kemiri.data.ConnectionStatus
import io.github.mitzacoder.kemiri.data.HarnessClient
import io.github.mitzacoder.kemiri.data.SignedInSocket
import io.github.mitzacoder.kemiri.features.chat.saveArtifactBytes
import io.github.mitzacoder.kemiri.protocol.ArtifactsUrlRequest
import io.github.mitzacoder.kemiri.protocol.ArtifactsUrlResponse
import io.github.mitzacoder.kemiri.protocol.NotificationPayload
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit

private const val reviewPictureTimeoutMs = 1_800L
private const val reviewPictureTransferBytes = 2 * 1024 * 1024
private const val reviewPictureMaxSide = 640
private val proofImageId = Regex("[A-Za-z0-9_-]{1,100}~[1-9][0-9]{0,15}")

internal fun isReviewPictureUrl(origin: String, url: String, projectId: String, artifactId: String): Boolean {
    val backend = origin.toHttpUrlOrNull() ?: return false
    val picture = url.toHttpUrlOrNull() ?: return false
    return backend.scheme == picture.scheme && backend.host == picture.host && backend.port == picture.port &&
        picture.username.isEmpty() && picture.password.isEmpty() && picture.fragment == null &&
        picture.pathSegments == listOf("artifacts", projectId, artifactId) && !picture.queryParameter("token").isNullOrEmpty()
}

internal fun reviewPictureSample(width: Int, height: Int): Int? {
    if (width <= 0 || height <= 0 || width > 8192 || height > 8192) return null
    var sample = 1
    while ((maxOf(width, height) + sample - 1) / sample > reviewPictureMaxSide) sample *= 2
    return sample
}

/** Only versioned thumbnails live in RAM. The signed URL never enters a notification, log, or disk cache. */
internal object ReviewPictures {
    private data class CacheKey(val origin: String, val binding: PushActionBinding, val projectId: String, val artifactId: String)
    private val cache = object : LruCache<CacheKey, Bitmap>(4 * 1024 * 1024) {
        override fun sizeOf(key: CacheKey, value: Bitmap): Int = value.allocationByteCount
    }
    private val downloadSlot = Semaphore(1)
    private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .callTimeout(reviewPictureTimeoutMs, TimeUnit.MILLISECONDS).build()

    suspend fun load(app: HarnessApplication, backend: BackendConfig, payload: NotificationPayload): Bitmap? {
        val projectId = payload.projectId ?: return null
        val artifactId = payload.proofArtifactId?.takeIf(proofImageId::matches) ?: return null
        return withTimeoutOrNull(reviewPictureTimeoutMs) {
            try {
                val binding = app.notificationActionBinding(backend.key) ?: return@withTimeoutOrNull null
                val key = CacheKey(backend.key, binding, projectId, artifactId)
                downloadSlot.withPermit {
                    cache.get(key) ?: download(app, backend, key)?.let { bitmap ->
                        if (app.notificationActionBinding(backend.key) != binding) return@let null
                        cache.put(key, bitmap)
                        bitmap
                    }
                }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { null }
        }
    }

    private suspend fun download(app: HarnessApplication, backend: BackendConfig, key: CacheKey): Bitmap? {
        val existing = app.notificationClient(backend.key)
        val client = existing ?: HarnessClient(backend, deviceAuth = app.deviceAuthFor(backend.key)).also { it.connect() }
        val url = try {
            val ready = client.state.first { it.status == ConnectionStatus.Ready || it.status == ConnectionStatus.Closed }
            if (ready.status != ConnectionStatus.Ready) return null
            val request = ArtifactsUrlRequest(projectId = key.projectId, artifactId = key.artifactId)
            client.exchangeAsSession(SignedInSocket(key.binding.backendId, key.binding.sessionId), request.id, request,
                ArtifactsUrlRequest.serializer(), ArtifactsUrlResponse.serializer()).url
        } finally { if (existing == null) client.close() }
        if (!isReviewPictureUrl(backend.url, url, key.projectId, key.artifactId)) return null
        val buffer = object : ByteArrayOutputStream() {
            override fun write(bytes: ByteArray, offset: Int, length: Int) {
                check(length <= reviewPictureTransferBytes - size())
                super.write(bytes, offset, length)
            }
        }
        saveArtifactBytes(http, url) { buffer }
        return withContext(Dispatchers.IO) {
            val bytes = buffer.toByteArray()
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outMimeType !in setOf("image/png", "image/jpeg", "image/webp")) return@withContext null
            val sample = reviewPictureSample(bounds.outWidth, bounds.outHeight) ?: return@withContext null
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        }
    }
}
