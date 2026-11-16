package io.github.mitzacoder.kemiri.chat

import io.github.mitzacoder.kemiri.features.chat.projectWorkerModelRows
import io.github.mitzacoder.kemiri.protocol.ModelInfo
import io.github.mitzacoder.kemiri.protocol.WorkerModel
import org.junit.Assert.assertEquals
import org.junit.Test

class ProjectWorkerModelsTest {
    private fun ref(id: String, thinking: String? = null) = WorkerModel(provider = "example",modelId = id,thinkingLevel = thinking)
    private fun model(id: String, configured: Boolean = true) = ModelInfo(provider = "example",modelId = id,name = id.uppercase(),contextWindow = 1000,maxTokens = 100,input = listOf("text"),reasoning = true,thinkingLevels = listOf("low","high"),configured = configured)
    private val catalog = listOf(model("swift",false),model("careful"))

    @Test fun preferenceOrderSkipsMissingModelsButDoesNotHideThem() {
        val rows = projectWorkerModelRows(listOf(ref("removed"),ref("careful","high"),ref("swift")),catalog,null)
        assertEquals(listOf(1,2,3),rows.map { it.order })
        assertEquals(listOf("Unavailable","Default","Fallback"),rows.map { it.role })
        assertEquals(listOf("removed","CAREFUL","SWIFT"),rows.map { it.name })
        assertEquals(listOf(null,"high",null),rows.map { it.thinking })
        assertEquals(listOf("example","example","example"),rows.map { it.provider })
    }
    @Test fun composerThinkingWinsIncludingOff() {
        assertEquals(listOf("off","off"),projectWorkerModelRows(listOf(ref("swift","high"),ref("careful")),catalog,"off").map { it.thinking })
    }
    @Test fun credentialStatusIsNotAvailability() {
        assertEquals(listOf("Default","Fallback"),projectWorkerModelRows(listOf(ref("swift"),ref("careful")),catalog,null).map { it.role })
    }
    @Test fun emptySettingsDoNotInventABackendFallback() {
        assertEquals(emptyList<Any>(),projectWorkerModelRows(emptyList(),catalog,null))
        assertEquals("Unavailable",projectWorkerModelRows(listOf(ref("removed")),emptyList(),null).single().role)
    }
}
