package io.github.mitzacoder.kemiri.settings

import io.github.mitzacoder.kemiri.features.chat.groupModels
import io.github.mitzacoder.kemiri.features.chat.projectWorkerModelRows
import io.github.mitzacoder.kemiri.features.settings.*
import io.github.mitzacoder.kemiri.protocol.*
import org.junit.Assert.*
import org.junit.Test

/** Official agents (T304 / D106): the login, version and warning wording and which pickers may offer a worker-only model. */
class OfficialAgentsTest {
    private val warning = "Synthetic warning: the subscription may be suspended. A key avoids that."
    private fun agent(authType: String?, installed: String? = "1.5.12", configured: Boolean = authType != null, oauth: Boolean = true) = ProviderInfo(
        id = "antigravity", name = "Google Antigravity (official agent)", configured = configured, authType = authType,
        oauth = if (oauth) ProviderOAuthInfo(name = "Google AI subscription", loginLabel = "Sign in with Google", isSubscription = true) else null,
        officialAgent = ProviderInfoOfficialAgent(pinnedVersion = "1.5.12", installedVersion = installed, subscriptionWarning = warning),
    )
    private val native = ProviderInfo(id = "example", name = "Example", configured = true, authType = "api_key")
    private fun model(provider: String, id: String, workerOnly: Boolean? = null, configured: Boolean = true) = ModelInfo(
        workerOnly = workerOnly, provider = provider, modelId = id, name = id.uppercase(), contextWindow = 200_000, maxTokens = 8000,
        input = listOf("text"), reasoning = false, thinkingLevels = emptyList(), configured = configured,
    )
    private val catalog = listOf(model("example", "swift"), model("antigravity", "gemini-3.8-flash", workerOnly = true), model("example", "careful", workerOnly = false))

    @Test fun theLoginInUseIsNamedFromTheAuthType() {
        assertEquals("Google subscription", officialAgentLogin(agent("oauth")))
        assertEquals("Gemini API key", officialAgentLogin(agent("api_key")))
        assertEquals("Not signed in", officialAgentLogin(agent(null)))
    }

    @Test fun theVersionIsInstalledOrWillBeInstalledOnFirstUse() {
        assertEquals("agy 1.5.12", officialAgentVersion(agent("oauth")))
        assertEquals("Installs agy 1.5.12 on first use", officialAgentVersion(agent(null, installed = null)))
        assertEquals("Official agent · agy 1.5.12", officialAgentHint(agent("api_key")))
        assertNull(officialAgentVersion(native))
        assertNull(officialAgentHint(native))
    }

    @Test fun theWarningShowsWhileTheSubscriptionIsInUseAndBeforeSigningInToIt() {
        assertEquals(warning, subscriptionWarning(agent("oauth"), canLogin = false))
        assertEquals(warning, subscriptionWarning(agent(null, configured = false), canLogin = true))
        assertEquals(warning, subscriptionWarning(agent("api_key"), canLogin = true))
        assertNull("no subscription choice and no subscription in use", subscriptionWarning(agent("api_key"), canLogin = false))
        assertNull(subscriptionWarning(agent("api_key", oauth = false), canLogin = true))
        assertNull(subscriptionWarning(native, canLogin = true))
        assertTrue(usesSubscription(agent("oauth")))
        assertFalse(usesSubscription(agent("api_key")))
    }

    @Test fun anOfficialAgentIsMarkedInAddAProviderAndItsKeyIsAGeminiKey() {
        val option = providerOptions(listOf(agent(null, configured = false))).single()
        assertEquals("Official agent", option.badge)
        assertTrue(option.keywords.contains("Official agent"))
        assertEquals("Gemini API key", officialAgentKeyLabel(agent(null), stored = false))
        assertEquals("Replace stored key", officialAgentKeyLabel(agent("api_key"), stored = true))
        assertEquals("API key", officialAgentKeyLabel(native, stored = false))
        assertEquals("Google subscription" to ChipTone.Ok, providerHow(agent("oauth"), listOf(CredentialInfo("antigravity", "oauth"))))
        assertEquals("Gemini API key" to ChipTone.Ok, providerHow(agent("api_key"), listOf(CredentialInfo("antigravity", "api_key"))))
    }

    @Test fun workerOnlyModelsNeverReachACoordinatorPicker() {
        assertEquals(listOf("swift", "careful"), nonWorkerModels(catalog).map { it.modelId })
        assertEquals(listOf("swift", "careful"), modelsForPicker(catalog, workerPicker = false).map { it.modelId })
        val coordinator = modelOptions(nonWorkerModels(catalog), listOf(native, agent("oauth")))
        assertTrue(coordinator.none { it.value.startsWith("antigravity/") })
        assertTrue(groupModels(nonWorkerModels(catalog), listOf(native, agent("oauth")), "").none { it.id == "antigravity" })
    }

    @Test fun workerPickersKeepEveryModelAndMarkTheOfficialAgentOnes() {
        assertEquals(catalog, modelsForPicker(catalog, workerPicker = true))
        val options = modelOptions(catalog, listOf(native, agent("oauth"))).associateBy { it.value }
        assertEquals("gemini-3.8-flash · 200k context · Official agent", options.getValue("antigravity/gemini-3.8-flash").description)
        assertEquals("swift · 200k context", options.getValue("example/swift").description)
        assertEquals("careful · 200k context", options.getValue("example/careful").description)
        val rows = projectWorkerModelRows(listOf(WorkerModel(provider = "antigravity", modelId = "gemini-3.8-flash", thinkingLevel = null), WorkerModel(provider = "example", modelId = "swift", thinkingLevel = null)), catalog, null)
        assertEquals(listOf(true, false), rows.map { it.officialAgent })
    }
}
