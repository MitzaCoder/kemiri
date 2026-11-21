package io.github.mitzacoder.kemiri.features.chat

import kotlinx.serialization.json.*
import org.eclipse.tm4e.core.grammar.IGrammar
import org.eclipse.tm4e.core.registry.IGrammarSource
import org.eclipse.tm4e.core.registry.IRegistryOptions
import org.eclipse.tm4e.core.registry.IThemeSource
import org.eclipse.tm4e.core.registry.Registry
import java.io.InputStream
import java.util.Locale
import java.util.zip.GZIPInputStream
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

internal const val CHAT_TEXTMATE_ASSETS = "chat-textmate/"

internal fun fenceLanguageLabel(language: String): String =
    language.trimStart().takeWhile { !it.isWhitespace() }.lowercase(Locale.ROOT)

/** Each theme has its own registry: tm4e caches themed attributes in grammar state. */
internal class ChatTextMate(private val openAsset: (String) -> InputStream) {
    internal data class Grammar(val name: String, val scope: String, val labels: List<String>, val injectTo: List<String>)

    val grammars by lazy {
        readJson("grammars.json").jsonArray.map { entry ->
            val grammar = entry.jsonObject
            Grammar(grammar.getValue("name").jsonPrimitive.content,
                grammar.getValue("scopeName").jsonPrimitive.content,
                grammar.getValue("labels").jsonArray.map { it.jsonPrimitive.content },
                grammar.getValue("injectTo").jsonArray.map { it.jsonPrimitive.content })
        }
    }
    private val scopeIndex by lazy { grammars.associateBy(Grammar::scope) }
    private val labelIndex by lazy { grammars.flatMap { g -> g.labels.map { it to g.scope } }.toMap() }
    private val injections by lazy {
        grammars.flatMap { g -> g.injectTo.map { it to g.scope } }.groupBy({ it.first }, { it.second })
    }
    private val latte by lazy { createRegistry(dark = false) }
    private val mocha by lazy { createRegistry(dark = true) }

    fun scopeForFence(language: String): String? = labelIndex[fenceLanguageLabel(language)]

    fun <T> withGrammar(scope: String, dark: Boolean, tokenize: (IGrammar, List<String?>) -> T): T? {
        val registry = if (dark) mocha else latte
        // Grammar loading and tokenisation share mutable tm4e caches. Don't run either concurrently in one registry.
        return synchronized(registry) {
            val grammar = registry.grammarForScopeName(scope) ?: registry.loadGrammar(scope) ?: return@synchronized null
            tokenize(grammar, registry.colorMap)
        }
    }

    private fun readJson(name: String): JsonElement =
        openAsset(name).bufferedReader().use { Json.parseToJsonElement(it.readText()) }

    private fun createRegistry(dark: Boolean): Registry {
        val registry = Registry(object : IRegistryOptions {
            override fun getGrammarSource(scopeName: String): IGrammarSource? {
                val grammar = scopeIndex[scopeName] ?: return null
                return IGrammarSource.fromInputStream(
                    GZIPInputStream(openAsset("${grammar.name}.json.gzip")), "${grammar.name}.json", Charsets.UTF_8,
                )
            }
            override fun getInjections(scopeName: String): Collection<String> = injections[scopeName].orEmpty()
        })
        val name = if (dark) "catppuccin-mocha" else "catppuccin-latte"
        val theme = readJson("$name.json").jsonObject
        val themed = if (dark) theme else adjustLatteTheme(theme)
        registry.setTheme(IThemeSource.fromString(IThemeSource.ContentType.JSON, themed.toString()))
        return registry
    }
}

internal fun adjustLatteTheme(theme: JsonObject): JsonObject {
    val adjusted = mutableMapOf<String, String>()
    return JsonObject(theme + ("settings" to JsonArray(theme.getValue("settings").jsonArray.map { entry ->
        val rule = entry.jsonObject
        val settings = rule.getValue("settings").jsonObject
        val foreground = settings["foreground"]?.jsonPrimitive?.content ?: return@map rule
        val contrasted = adjusted.getOrPut(foreground) { darkenLatteToken(foreground) }
        JsonObject(rule + ("settings" to JsonObject(settings + ("foreground" to JsonPrimitive(contrasted)))))
    })))
}

private fun rgb(hex: String) = hex.removePrefix("#").chunked(2).map { it.toInt(16) / 255.0 }

internal fun contrastOnWhite(hex: String): Double {
    val (r, g, b) = rgb(hex).map { if (it <= .04045) it / 12.92 else ((it + .055) / 1.055).pow(2.4) }
    return 1.05 / (.2126 * r + .7152 * g + .0722 * b + .05)
}

/** Keep hue/saturation, lowering HSL lightness by one percentage point until the rounded RGB passes. */
internal fun darkenLatteToken(hex: String): String {
    if (contrastOnWhite(hex) >= 4.5) return hex
    val (r, g, b) = rgb(hex)
    val high = max(r, max(g, b))
    val low = min(r, min(g, b))
    val chroma = high - low
    var lightness = (high + low) / 2
    val saturation = if (chroma == 0.0) 0.0 else chroma / (1 - abs(2 * lightness - 1))
    val hue = when {
        chroma == 0.0 -> 0.0
        high == r -> ((g - b) / chroma + 6) % 6
        high == g -> (b - r) / chroma + 2
        else -> (r - g) / chroma + 4
    }
    var adjusted: String
    do {
        lightness = (lightness - .01).coerceAtLeast(0.0)
        val c = (1 - abs(2 * lightness - 1)) * saturation
        val x = c * (1 - abs(hue % 2 - 1))
        val m = lightness - c / 2
        val channels = when {
            hue < 1 -> listOf(c, x, 0.0)
            hue < 2 -> listOf(x, c, 0.0)
            hue < 3 -> listOf(0.0, c, x)
            hue < 4 -> listOf(0.0, x, c)
            hue < 5 -> listOf(x, 0.0, c)
            else -> listOf(c, 0.0, x)
        }
        adjusted = channels.joinToString("", prefix = "#") { ((it + m) * 255).roundToInt().toString(16).padStart(2, '0') }
    } while (contrastOnWhite(adjusted) < 4.5)
    return adjusted
}
