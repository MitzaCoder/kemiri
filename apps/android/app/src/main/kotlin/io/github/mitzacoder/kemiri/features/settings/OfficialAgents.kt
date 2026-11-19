package io.github.mitzacoder.kemiri.features.settings

import io.github.mitzacoder.kemiri.protocol.ModelInfo
import io.github.mitzacoder.kemiri.protocol.ProviderInfo

/**
 * Official agents (T304 / D106): worker-only providers that run a vendor's own agent. Pure presentation and filtering, so
 * the wording (shared with the web) and the picker rules are tested without a screen.
 */
internal const val OFFICIAL_AGENT_LABEL = "Official agent"

/** The login in use, as Accounts names it: `authType` "oauth" is the subscription, "api_key" the key. */
internal fun officialAgentLogin(provider: ProviderInfo): String = when (provider.authType) {
    "oauth" -> "Google subscription"
    "api_key" -> "Gemini API key"
    else -> "Not signed in"
}

/** The agent's command name; `agy` is the only one so far. */
internal fun officialAgentName(provider: ProviderInfo): String = if (provider.id == "antigravity") "agy" else provider.id

/** "agy 1.5.12" once installed, else what the first use will install. */
internal fun officialAgentVersion(provider: ProviderInfo): String? = provider.officialAgent?.let { agent ->
    val name = officialAgentName(provider)
    agent.installedVersion?.let { "$name $it" } ?: "Installs $name ${agent.pinnedVersion} on first use"
}

/** The subscription is in use now. */
internal fun usesSubscription(provider: ProviderInfo): Boolean = provider.officialAgent != null && provider.authType == "oauth"

/**
 * The server's warning, whenever the subscription is in use and before signing in to it: wherever the subscription
 * sign-in is offered (`canLogin` and the provider has one), even while a key is in use.
 */
internal fun subscriptionWarning(provider: ProviderInfo, canLogin: Boolean): String? {
    val agent = provider.officialAgent ?: return null
    return agent.subscriptionWarning.takeIf { usesSubscription(provider) || (canLogin && provider.oauth != null) }
}

/** The key field's label: the agent's key is a Gemini key. */
internal fun officialAgentKeyLabel(provider: ProviderInfo, stored: Boolean): String =
    (if (provider.officialAgent != null) "Gemini API key" else "API key").let { if (stored) "Replace stored key" else it }

internal fun isWorkerOnly(model: ModelInfo): Boolean = model.workerOnly == true

/**
 * What a coordinator, a background job, memory maintenance or the report audit may pick: never a worker-only model.
 * Worker pickers (composer, Project → Workers, a worker schedule) use the whole catalog.
 */
internal fun nonWorkerModels(models: List<ModelInfo>): List<ModelInfo> = models.filterNot(::isWorkerOnly)

/** Models for the picker of [workerPicker] kind: workers see the whole catalog, everything else only non-worker models. */
internal fun modelsForPicker(models: List<ModelInfo>, workerPicker: Boolean): List<ModelInfo> = if (workerPicker) models else nonWorkerModels(models)

/** A ready row's one-line hint: "Official agent · agy 1.5.12". */
internal fun officialAgentHint(provider: ProviderInfo): String? =
    officialAgentVersion(provider)?.let { "$OFFICIAL_AGENT_LABEL · $it" }
