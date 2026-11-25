package io.github.mitzacoder.kemiri.chat

import io.github.mitzacoder.kemiri.features.chat.artifactThumbnailMemoryKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ArtifactThumbnailCacheTest {
    @Test fun imagePixelsAreSharedOnlyWithinTheSameArtifactVersionAndScope() {
        val backend = "https://example.invalid"
        val key = artifactThumbnailMemoryKey(backend, "project", "art~1")
        assertEquals(key, artifactThumbnailMemoryKey(backend, "project", "art~1"))
        assertNotEquals(key, artifactThumbnailMemoryKey(backend, "project", "art~2"))
        assertNotEquals(key, artifactThumbnailMemoryKey(backend, "other", "art~1"))
        assertNotEquals(key, artifactThumbnailMemoryKey("https://other.example.invalid", "project", "art~1"))
    }
}
