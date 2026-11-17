package io.github.mitzacoder.kemiri.features.chat

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import java.util.UUID

internal val REVIEW_INTENTS = listOf("Clarify", "Change", "Show differently", "Cut", "Keep")
internal val REVIEW_BLOCKS = listOf("chart", "table row", "figure", "image", "code", "list item", "paragraph", "block")
internal const val REVIEW_SELECTION_TYPE = "kemiri:artifact-selection"
@Serializable internal data class ArtifactSelection(val text: String, val section: String? = null, val elementId: String? = null, val block: String? = null)
@Serializable internal data class ReviewComment(val text: String, val section: String? = null, val elementId: String? = null, val block: String? = null, val intent: String? = null, val note: String = "") {
    fun selection() = ArtifactSelection(text, section, elementId, block)
}
@Serializable internal data class ArtifactReview(val comments: List<ReviewComment> = emptyList(), val overall: String = "")
@Serializable internal data class ReviewArtifact(val title: String, val id: String, val version: Long, val name: String)

internal fun reviewText(text: String, limit: Int): String {
    val clean = text.replace(Regex("\r\n?"), "\n").replace('\u00a0', ' ')
        .replace(Regex("[ \\t]+$", RegexOption.MULTILINE), "").replace(Regex("\n{3,}"), "\n\n")
        .replace(Regex("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]"), "").trim { it.isWhitespace() || it == '\ufeff' }
    return if (clean.length > limit) clean.take(limit - 1) + "…" else clean
}
/** WebView results are untrusted text, never markup or app commands. */
internal fun validateArtifactSelection(input: JsonElement?): ArtifactSelection? {
    val fields = input as? JsonObject ?: return null
    if (fields.keys.any { it !in setOf("type", "text", "section", "elementId", "block") }) return null
    if (fields.values.any { it !is JsonPrimitive || !it.isString }) return null
    fun field(key: String) = (fields[key] as? JsonPrimitive)?.content
    if (field("type") != REVIEW_SELECTION_TYPE || field("text") == null) return null
    if (field("block")?.let { it !in REVIEW_BLOCKS } == true) return null
    return ArtifactSelection(reviewText(field("text")!!, 4000), field("section")?.let { reviewText(it, 300) }, field("elementId")?.let { reviewText(it, 120) }, field("block"))
}
internal fun decodeArtifactSelection(evaluated: String): ArtifactSelection? = runCatching {
    if (evaluated.length > 100_000) return null
    val outer = Json.parseToJsonElement(evaluated) as? JsonPrimitive ?: return null
    if (!outer.isString) return null
    validateArtifactSelection(Json.parseToJsonElement(outer.content))
}.getOrNull()
internal fun reviewLocation(selection: ArtifactSelection) = listOf(reviewText(selection.section.orEmpty(), 300), selection.block?.let { "($it)" }.orEmpty()).filter { it.isNotEmpty() }.joinToString(" ")
internal fun formatArtifactReview(artifact: ReviewArtifact, review: ArtifactReview): String {
    val title = reviewText(artifact.title, 300).replace('"', '′').replace('\n', ' ')
    val header = "Comments on \"$title\"\n(artifact ${artifact.id.replace(Regex("~\\d+$"), "")}~${artifact.version}, ${reviewText(artifact.name, 300).replace('\n', ' ')})"
    val comments = review.comments.mapIndexed { index, comment ->
        val location = reviewLocation(comment.selection())
        val quote = reviewText(comment.text, 4000).split('\n').joinToString("\n") { if (it.isEmpty()) ">" else "> $it" }
        val note = reviewText(comment.note, 4000)
        "${index + 1}. ${comment.intent ?: "Note"}${if (location.isEmpty()) "" else " · $location"}\n$quote${if (note.isEmpty()) "" else "\n\n$note"}"
    }
    val overall = reviewText(review.overall, 4000)
    return (listOf(header) + comments + if (overall.isEmpty()) emptyList() else listOf("Overall: $overall")).joinToString("\n\n")
}
internal fun artifactReviewKey(backend: String, project: String, id: String, version: Long) =
    "kemiri.artifact-review.v1:" + JsonArray(listOf(JsonPrimitive(backend), JsonPrimitive(project), JsonPrimitive(id.replace(Regex("~\\d+$"), "")), JsonPrimitive(version))).toString()
internal interface ReviewStorage { fun get(key: String): String?; fun set(key: String, text: String); fun remove(key: String) }
internal fun loadArtifactReview(storage: ReviewStorage, key: String): ArtifactReview = runCatching {
    val saved = Json.parseToJsonElement(storage.get(key) ?: return ArtifactReview()).jsonObject
    val overall = saved["overall"] as? JsonPrimitive ?: return ArtifactReview()
    if (!overall.isString) return ArtifactReview()
    val comments = (saved["comments"] as? JsonArray ?: return ArtifactReview()).take(100).mapNotNull { input ->
        val comment = input as? JsonObject ?: return@mapNotNull null
        val note = comment["note"] as? JsonPrimitive ?: return@mapNotNull null
        val intent = comment["intent"]?.let { (it as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@mapNotNull null }
        if (!note.isString || (intent != null && intent !in REVIEW_INTENTS)) return@mapNotNull null
        val selection = validateArtifactSelection(JsonObject(mapOf("type" to JsonPrimitive(REVIEW_SELECTION_TYPE)) + comment.filterKeys { it != "note" && it != "intent" })) ?: return@mapNotNull null
        if (selection.text.isEmpty() || (intent == null && note.content.isBlank())) return@mapNotNull null
        ReviewComment(selection.text, selection.section, selection.elementId, selection.block, intent, reviewText(note.content, 4000))
    }
    ArtifactReview(comments, reviewText(overall.content, 4000))
}.getOrDefault(ArtifactReview())
internal fun saveArtifactReview(storage: ReviewStorage, key: String, review: ArtifactReview): Boolean = runCatching {
    if (review.comments.isEmpty() && review.overall.isBlank()) storage.remove(key) else storage.set(key, Json { encodeDefaults = true; explicitNulls = false }.encodeToString(review))
}.isSuccess
internal fun reviewThreadId(taskId: String?, sourceThreadId: String?) = if (!taskId.isNullOrEmpty()) null else sourceThreadId
internal class ArtifactReviewSubmission(private val createId: () -> String = { "review-${UUID.randomUUID()}" }) {
    private var attempted: Pair<String, String>? = null
    fun requestIdFor(text: String): String { if (attempted?.first != text) attempted = text to createId(); return attempted!!.second }
    fun accepted() { attempted = null }
}
/** Native readers choose a paragraph without trying to read Compose's private selection state. */
internal fun artifactReviewParagraphs(text: String): List<ArtifactSelection> {
    var section = ""
    return text.split(Regex("\n\\s*\n")).mapNotNull { paragraph ->
        val clean = reviewText(paragraph, 4000)
        if (Regex("^#{1,6}\\s+[^\\n]+$").matches(clean)) { section = reviewText(clean.replace(Regex("^#{1,6}\\s+"), ""), 300); null }
        else clean.takeIf { it.isNotBlank() }?.let { ArtifactSelection(it, section, block = "paragraph") }
    }
}

internal fun reviewCommentCount(count: Int) = "$count ${if (count == 1) "comment" else "comments"}"
