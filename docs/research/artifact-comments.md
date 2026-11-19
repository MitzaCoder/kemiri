# Comments in place on an artifact (T337)

A design and a staged plan. Only the first slice of code exists, as an unfinished commit (see "What the kept
code covers"). No UI is built. A clickable mockup with synthetic data is saved on the task as
`artifact-comments-mockup.html`.

## What the owner gets

- Selecting text, or picking a block, opens a **comment card** next to it. The owner types there and saves.
- A saved comment leaves a **pin** on its element, with the number of comments on that element.
- Hovering a pin (tapping it on a phone) **previews** its comments. Each has Edit and Delete.
- The tray, "Send N comments" and "Add to chat draft" stay. The review message does not change.

## What exists today

`ArtifactReview.svelte` owns the review: a controls bar (Pick a block, Comments · N, "Comment on …"), and a
tray that holds the composer form, the list, the whole-page note and Send. Selecting never opens anything by
itself: the owner selects, presses "Comment on …", and types in the tray, away from the selection. Saved
comments are visible only in the tray.

HTML runs in a sandboxed `srcdoc` frame. `artifact-review-frame.ts` is injected into it and posts one message,
`kemiri:artifact-selection`, which `validateArtifactSelection` checks. The parent sends two exact strings to
start and cancel block picking. Markdown, text and Source are the app's own DOM and use `document.getSelection`.

## Design

### One anchor per comment

A comment gains an optional `anchor` string. It only places the pin on this device. `formatArtifactReview`
picks its fields by name, so the anchor never reaches the message and the golden fixtures stay valid.

| View | Anchor | Meaning |
| --- | --- | --- |
| HTML page | `p:0.3.1` | child indexes from `body` to the element |
| Rendered Markdown | `m:2.0` | child indexes from the Markdown root to the block |
| Text and Source | `s:1234` | character offset of the selection start |

The prefix keeps a page anchor from being resolved in the Source view of the same artifact. A review is keyed
by artifact version and a version's bytes never change, so a path is stable. A page whose scripts build the DOM
differently on each load can lose a pin; the comment then stays in the tray only. Comments saved before this
change have no anchor and behave the same way.

### Over the sandboxed frame

No new sandbox permission and nothing editable inside the page. The frame script only reports rectangles:

- A selection message may carry `anchor` (a bare path, checked by a strict pattern).
- A second message, `kemiri:artifact-anchors`, has one string: `*=x,y,w,h|0.3.1=x,y,w,h|…` in the frame's own
  viewport pixels. `*` is the live selection. The frame sends it with every selection and again, once per
  animation frame, after scroll, resize, load or a layout change.
- The parent sends `kemiri:watch-artifact-anchors:<path>|<path>…` (at most 100 validated paths) to say which
  elements to report, and `kemiri:clear-artifact-selection` after save or cancel.

The app validates the source window, the exact keys, string values and bounded integers, as it does for
selections. A hostile page can misplace its own pins inside the frame's box and nothing more.

The app draws two absolutely positioned layers in `.review-layout`, sized to the frame's box: pins below the
tray, the card above the controls. Frame pixels map one to one onto the layer. A pin whose element is out of
view is hidden; a pin of a partly visible element stays on the visible edge.

For Markdown and text the app resolves anchors itself (`anchorClientRect`) and recomputes on scroll (capture
listener), `ResizeObserver` and comment changes. The same layers and components are used, with the scroller
(`.reading-document`) as the surface.

### The comment card

- Opens by itself: after a block pick, and after a text selection ends. The frame holds a text selection back
  until the pointer is released, so the card does not appear mid-drag.
- Content: location line, the quote clamped to two lines, the five intent chips, an auto-growing text area,
  Cancel and Save. Notes stay plain text, as the message format requires. "Rich" here means the card, not
  formatted text.
- Keys: Enter and Cmd/Ctrl+Enter save, Shift+Enter is a new line, Esc cancels. On touch devices Enter is a new
  line, as in the chat composer.
- Placement (`placeReviewCard`): below the target, else above, else over its visible part, never outside the
  surface. Width `min(360px, surface − 16px)`.
- While nothing is typed and no intent is chosen, a new selection moves the card and an empty selection closes
  it. Once touched, it stays until Save, Cancel or Esc.
- The target gets an outline drawn by the app layer, because focusing the text area drops the native selection
  highlight in Markdown and text.
- Editing a comment whose anchor resolves opens the same card on its element. Without a resolvable anchor, the
  existing form in the tray is the fallback, so nothing becomes uneditable.

### Pins and preview

- One pin per anchor at the element's top right corner, with a count. Overlapping pins step left.
- Desktop: hover or keyboard focus opens the preview; it stays while the pointer is on the pin or the card.
  Click keeps it open. Esc, an outside click or the window losing focus to the frame closes it.
- The preview lists intent and note for each comment, with Edit and Delete. Hovering outlines the element.
- The tray no longer opens by itself on a new comment; the counter still opens it.

### Phone widths

- The same card at full width minus margins. It does not take focus by itself on a coarse pointer, so the
  selection handles stay usable and the keyboard does not cover the page unasked.
- A tap on a pin toggles the preview. A tap outside closes it.
- The tray stays the bottom sheet. Opening the card or a preview closes the sheet.

### To verify in the browser first

These are assumptions from reading the code, not observed:

- The frame's selection survives focus moving to the parent's text area.
- `pointerup` reaches the frame when a drag ends outside it.
- Frame pixels match the layer while the dialog's open animation runs.

## What the kept code covers

One unfinished commit with the `Kemiri-Task: T337` trailer. It type-checks. Nothing in it was run in a browser.

- `artifact-review-frame.ts`: element paths, the `kemiri:artifact-anchors` report, the watch and clear
  messages, scroll/resize/layout reporting, and holding a text selection until pointer release.
- `artifact-review.ts`: the `anchor` field, its validation in a selection message (stored as `p:<path>`), and
  keeping a valid anchor when a review is loaded.
- `artifact-review-anchors.ts` (new): `validateArtifactRects`, `watchAnchorsMessage`, `reviewPins`,
  `placeReviewCard`, and the Markdown/text helpers `blockPath`, `textOffset`, `anchorClientRect`.

Known gaps in it:

- Eleven web cases in `artifact-review-frame.test.ts` fail. Their harness collects every posted message and
  compares whole objects; it must separate the rectangle messages and expect the `anchor` key.
- The new module has no tests.
- No component uses any of it. `DESIGN.md` is not updated.

## Stages

Each stage is one worker. Every web stage ends with, in `apps/web`: `bun run check`, `bun test`,
`bun run build`; at the root `bun run typecheck`; and the public check. UI stages add before/after screenshots
on desktop and phone in light and dark.

1. **Finish the bridge.** Fix the frame test harness. Add tests for rectangle validation (trust-boundary cases
   as for selections), pin grouping, card placement, the watch message and anchor load/save. Check the three
   assumptions above in a browser with a synthetic page and adjust the frame script. No visible change.
2. **Card and pins on HTML.** Split the composer out of `ArtifactReview.svelte` into a card component used by
   both the layer and the tray fallback. Add the pin layer and preview. Wire watch/clear messages and the
   rectangle state. Remove the "Comment on …" button. Proof: select, comment, save, pin, hover, edit, send.
3. **Markdown, text and Source.** App-side anchors and rectangles on the same components.
4. **Phone and finish.** Coarse-pointer focus rule, tap previews, sheet interplay, both themes, reduced motion,
   focus order and labels. Update `DESIGN.md`. Full proof set and the recording.
5. **Android (separate task).** See below.

Stages 3 and 4 can run in parallel after 2 if they agree on the card component's props first.

## Android parity

Not part of the web work. `ArtifactReviewPage.kt` reads selections with `evaluateJavascript` and a 300 ms
poll, and composes in Material bottom sheets. It needs:

- the path and rectangle functions added to its three scripts, shared with the web test that already runs both;
- an `anchor` on the Kotlin comment model and in SharedPreferences;
- a Compose layer over the WebView that draws pins from rectangles, refreshed on the WebView's scroll and
  layout callbacks rather than a faster poll;
- a tap on a pin opening the existing sheet, filtered to that element, with Edit and Delete.

The composer should stay a bottom sheet on Android: it already sits above the keyboard and matches the
platform. Only the pins and the automatic opening after a pick are new. Checks: `pgrep -fa gradle`, then the
Android build script with `testDebugUnitTest assembleDebug lintDebug`, and emulator proof.

## Other improvements found

Not built. Effort is for one worker: small is under a day, medium one to two days.

| Improvement | Effect | Effort |
| --- | --- | --- |
| "Send 1 comment", not "Send 1 comments" | Removes a visible grammar slip | Small |
| Undo after removing a comment | A mis-click no longer loses a written note | Small |
| Keep the card's unsaved text when the viewer closes | A half-written note survives Esc or a reload | Small |
| Stay in pick mode after saving | Several blocks in a row without pressing Pick each time | Small |
| Clicking a tray comment scrolls to its element and flashes it | The tray becomes a map of the page | Small, after stage 2 |
| Colour or icon for each intent | Cut, Change and Keep can be told apart at a glance | Small |
| Shrink the controls bar to one floating button | Frees the strip it reserves under every page | Small |
| Move the whole-page note above the list, or into the Send area | It is easy to miss at the bottom of a long tray | Small |
| Offer unsent comments again when a new version arrives | Comments are not stranded on the old version | Medium |
| Keep sent comments as faded pins with "sent" | The owner sees what was already asked for | Medium |
| Highlight the exact commented words, not only the block | Precise for long paragraphs | Medium |
| Point comments on images and video frames | Review of screenshots and recordings | Large |
