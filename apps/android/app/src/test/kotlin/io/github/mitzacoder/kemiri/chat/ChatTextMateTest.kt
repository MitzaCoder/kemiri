package io.github.mitzacoder.kemiri.chat

import io.github.mitzacoder.kemiri.features.chat.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.eclipse.tm4e.core.grammar.IStateStack
import org.eclipse.tm4e.core.internal.grammar.tokenattrs.EncodedTokenAttributes
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.Duration

class ChatTextMateTest {
    private val assets = File("src/main/assets/$CHAT_TEXTMATE_ASSETS")
    private val highlighter = ChatTextMate { assets.resolve(it).inputStream() }
    private val generousBudget = Duration.ofSeconds(5)

    @Test fun resolvesFenceLabelsAndNeverTreatsThemAsPaths() {
        for ((label, expected) in mapOf(
            " TS title=Bed " to "source.ts", "JAVASCRIPTREACT" to "source.js.jsx",
            "mjs" to "source.js", "kts" to "source.kotlin", "c++" to "source.cpp", "c#" to "source.cs",
            "dockerfile" to "source.dockerfile", "bash" to "source.shell", "yml" to "source.yaml", "diff" to "source.diff",
        )) assertEquals(label, expected, highlighter.scopeForFence(label))
        for (plain in listOf("", "text", "just-an-example", "../typescript", "cpp-macro")) {
            assertNull(plain, highlighter.scopeForFence(plain))
        }
    }

    @Test fun everyBundledGrammarTokenizesItsSample() {
        val samples = mapOf(
            "c" to "int bed = 2;", "cpp" to "constexpr auto bed = 2;", "cpp-macro" to "#define BED 2",
            "csharp" to "string bed = \"Fern\";", "css" to ".bed { color: green; }", "dart" to "final bed = 'Fern';",
            "diff" to "+const bed = 2;", "docker" to "FROM scratch", "fish" to "set bed Fern", "go" to "var bed = 2",
            "graphql" to "query { bed { name } }", "haml" to "%p Fern", "html" to "<strong>Fern</strong>",
            "html-derivative" to "<strong>Fern</strong>", "java" to "int bed = 2;", "javascript" to "const bed = 'Fern';",
            "json" to "{\"bed\": 2}", "jsx" to "const tag = <b>Fern</b>;", "kotlin" to "val bed = \"Fern\"",
            "lua" to "local bed = 'Fern'", "make" to "bed: seed", "markdown" to "# Fern",
            "markdown-nix" to "```nix\n{ bed = 2; }\n```", "nix" to "{ bed = 2; }", "php" to "<?php echo 'Fern'; ?>",
            "postcss" to ".bed { color: green; }", "python" to "bed = f'Fern {2}'", "regexp" to "(fern|basil)+",
            "ruby" to "bed = 'Fern'", "rust" to "let bed = \"Fern\";", "scss" to "\$bed: green;",
            "shellscript" to "echo \"Fern\"", "sql" to "SELECT name FROM beds;", "svelte" to "<p>{bed}</p>",
            "swift" to "let bed = \"Fern\"", "toml" to "bed = 'Fern'", "tsx" to "const tag = <b>Fern</b>;",
            "typescript" to "const bed: number = 2;", "xml" to "<bed>Fern</bed>", "yaml" to "bed: Fern",
        )
        assertEquals(samples.keys, highlighter.grammars.map { it.name }.toSet())
        for (entry in highlighter.grammars) {
            val parsed = highlighter.withGrammar(entry.scope, dark = false) { grammar, _ ->
                assertEquals(entry.scope, grammar.scopeName)
                var state: IStateStack? = null
                for (line in samples.getValue(entry.name).lines()) {
                    val tokens = grammar.tokenizeLine(line, state, generousBudget)
                    assertFalse(entry.name, tokens.isStoppedEarly)
                    assertTrue(entry.name, tokens.tokens.isNotEmpty())
                    state = tokens.ruleStack
                }
                true
            }
            assertEquals("Grammar loaded: ${entry.name}", true, parsed)
        }
    }

    @Test fun keywordsAndStringsGetLanguageScopes() {
        val declarations = listOf(
            Triple("source.ts", "\"Fern\"", "const bed: string = \"Fern\";"),
            Triple("source.js", "\"Fern\"", "const bed = \"Fern\";"),
            Triple("source.tsx", "\"Fern\"", "const bed = <Label name=\"Fern\" />;"),
            Triple("source.kotlin", "\"Fern\"", "val bed: String = \"Fern\""),
        )
        for ((scope, literal, line) in declarations) {
            val keyword = if (scope == "source.kotlin") "val" else "const"
            assertDeclarationScopes(scope, line, keyword, line.indexOf(literal) + 1)
        }
    }

    @Test fun svelteDelegatesKeywordsAndStringsToEmbeddedTypeScript() {
        val line = "let bed: string = \"Fern\";"
        assertDeclarationScopes("source.svelte", line, "let", line.indexOf("Fern"), opening = "<script lang=\"ts\">")
    }

    private fun assertDeclarationScopes(scope: String, line: String, keyword: String, stringOffset: Int, opening: String? = null) {
        highlighter.withGrammar(scope, dark = false) { grammar, _ ->
            val previous = opening?.let { grammar.tokenizeLine(it, null, generousBudget) }
            assertFalse(previous?.isStoppedEarly ?: false)
            val tokens = grammar.tokenizeLine(line, previous?.ruleStack, generousBudget)
            assertFalse(tokens.isStoppedEarly)
            fun scopesAt(offset: Int) = tokens.tokens.single { offset in it.startIndex until it.endIndex }.scopes
            val keywordScopes = scopesAt(line.indexOf(keyword))
            val stringScopes = scopesAt(stringOffset)
            assertTrue("$scope $keyword: $keywordScopes", keywordScopes.any { it.startsWith("keyword.") || it.startsWith("storage.type.") })
            assertTrue("$scope string: $stringScopes", stringScopes.any { it.startsWith("string.quoted.") })
            if (opening != null) {
                assertTrue("Embedded keyword: $keywordScopes", "source.ts" in keywordScopes)
                assertTrue("Embedded string: $stringScopes", "source.ts" in stringScopes)
            }
        } ?: fail("No grammar for $scope")
    }

    @Test fun timedOutFirstPassRetriesAndReturnsColoredSpansOffTheCallingThread() = runBlocking {
        val caller = Thread.currentThread()
        for (dark in listOf(false, true)) {
            val source = "type Plant = string;\nconst bed: Plant = \"Fern\";"
            val highlighted = ChatHighlighter.highlight(source, "ts", dark, firstLineBudget = Duration.ofNanos(1)) {
                assertNotSame(caller, Thread.currentThread())
                highlighter
            }
            assertEquals(source, highlighted.text)
            fun colorAt(text: String) = highlighted.spanStyles.single { source.indexOf(text) in it.start until it.end }.item.color
            assertEquals(colorAt("type"), colorAt("const"))
            assertNotEquals(colorAt("const"), colorAt("Fern"))
        }
    }

    @Test fun registryLazilyOpensAssetsAndKeepsSeparateThemeMetadata() {
        val opened = mutableListOf<String>()
        val engine = ChatTextMate { opened += it; assets.resolve(it).inputStream() }
        val scope = engine.scopeForFence("js")!!
        assertEquals(listOf("grammars.json"), opened)
        fun keywordColor(dark: Boolean) = engine.withGrammar(scope, dark) { grammar, colors ->
            val tokens = grammar.tokenizeLine2("export const bed = 2;").tokens
            colors[EncodedTokenAttributes.getForeground(tokens[1])]?.lowercase()
        }
        assertEquals("#8839ef", keywordColor(false))
        val firstLoad = opened.toList()
        assertTrue("javascript.json.gzip" in firstLoad)
        assertFalse("python.json.gzip" in firstLoad)
        assertEquals("#8839ef", keywordColor(false))
        assertEquals(firstLoad, opened)
        assertEquals("#cba6f7", keywordColor(true))
        assertEquals("#8839ef", keywordColor(false))
    }

    @Test fun everyLatteTokenForegroundPassesWhiteContrast() {
        val theme = Json.parseToJsonElement(assets.resolve("catppuccin-latte.json").readText()).jsonObject
        fun foregrounds(theme: JsonObject) = theme.getValue("settings").jsonArray.mapNotNull {
            it.jsonObject.getValue("settings").jsonObject["foreground"]?.jsonPrimitive?.content
        }
        val before = foregrounds(theme)
        assertTrue(before.any { contrastOnWhite(it) < 4.5 })
        for ((original, adjusted) in before.zip(foregrounds(adjustLatteTheme(theme)))) {
            assertTrue("$original -> $adjusted", contrastOnWhite(adjusted) >= 4.5)
            if (contrastOnWhite(original) >= 4.5) assertEquals(original, adjusted)
        }
        // Rounded 8-bit colours: #777777 misses, so the first 1% HSL step gives #747474.
        assertEquals("#747474", darkenLatteToken("#777777"))
        assertEquals("#767676", darkenLatteToken("#767676"))
    }
}
