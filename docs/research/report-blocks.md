# Typed report blocks and HTML section views (T356)

**Plan only.** Make a task report as easy to scan as a good HTML artifact, without asking agents to design a
web page for every task. Typed blocks are the report. An optional HTML view shows a table, diagram or visual
comparison that the blocks cannot express well. The report must still answer what changed, what is missing
and who acts next if the HTML never loads. Keep the vocabulary useful for any project (D85), including
projects with no code, checks or proof files.

## What changes on the page

A 400-word Results paragraph can mix the verdict, project and service settings, two findings, where the
proof lives and what was cleaned up. Give each of those a different shape. For example, a synthetic capacity
rehearsal could read like this:

| What the reader sees | What the agent writes |
| --- | --- |
| **The booking desk can handle the expected morning queue.** | Summary: one `outcome` |
| **Limit 1 held.** The desk accepted ten reservations in the first window. | `finding` with a short heading and its observation |
| **Limit 2 held.** The desk sent overflow to the waiting list. | A second `finding` |
| **Rehearsal setup** · Site: Linden Hall · Session: Morning · Intake: Reservation desk | One `setup` with named values. A software rehearsal could use Project, Port and Proxy in the same slots. |
| **Booking replay** · The replay shows the switch to the waiting list. | `proof` with a caption and a saved artifact reference |
| **Cleaned up** · The team removed the rehearsal reservations. | `cleanup` |

Put setup below the findings unless it is needed to understand them. Put anything still unfinished,
including unfinished cleanup, under Not done. A table comparing several sessions could get an **Open
comparison table** view; neither finding would require opening it.

### Block vocabulary and rendering

Use a discriminated `kind` and an ordered list per section. Fields are required unless marked optional.
Titles and values are plain text; short prose supports only the existing safe inline Markdown subset
(emphasis, code and safe links). The only multiline authored content in a block is the optional copyable
text on a step. Do not accept raw HTML, nested blocks, arbitrary styles or per-block badges. Use app
typography, spacing and tones. Keep prose near 65–75 characters across, even in a wide pane. On both apps,
icons and color support words, never replace them.

| Kind | Fields and meaning | Web | Android |
| --- | --- | --- | --- |
| `outcome` | `text`: what changed or is now possible. | Summary lead; in Results, a compact outcome row. No automatic pass mark. | Emphasized lead or compact text row, using app text sizes. |
| `finding` | `title`, `text`: an observed fact and its consequence or context. | Short bold heading above the observation; consecutive findings form a list with shared spacing. | Stacked heading and body, with the heading exposed to TalkBack. |
| `setup` | `title`, `facts[]` of `label`, `value`: only the conditions needed to interpret an outcome. | Label/value grid that wraps to stacked pairs. | Stacked label/value pairs, with long values wrapping. |
| `proof` | `text`: what the evidence shows; `artifactRef`: saved task artifact ID and optional retained version. | For image/video, use the existing proof thumbnail and viewer. For other files, use a titled file button with the caption. | Use the existing media or artifact route with a labeled touch target and the same caption. |
| `cleanup` | `text`: what was removed or restored, if it matters to the reader. | Quiet labeled row, not a checklist of internal work. | Compact “Cleaned up” row with body text. |
| `risk` | `title`, `text`: a limitation, gap or continuing risk and what it affects. | “Not done” row with a modest label or icon. A finding's material caveat can also use this row in Results. | Same readable label and body. No alert color or announcement by default. |
| `metric` | `label`, finite numeric `value`, optional `unit` and `context`: a meaningful measurement, not check counts. | Prominent value with its label; adjacent metrics can share a wrapping row. | Value and label together in reading order; stack them at large font sizes. |
| `step` | `text`: a verb-led instruction; optional `copyText`: exact value, command or multiline snippet; optional `language` for display only. | Numbered semantic list, with a separately labeled Copy button and safe code styling when relevant. | Numbered rows with selectable text and a full-size Copy target; no ellipsis or dropped lines. |
| `nextAction` | `text`: what an agent will do, naming the actor when useful. | One or two plain action rows, without checkboxes. | Short plain action rows, visually separate from Your steps. |

Summary accepts one or two `outcome` blocks. Results (the body of **What you get**) accepts outcome,
finding, setup, proof, cleanup, risk and metric. Not done accepts risk; Next accepts nextAction; Your steps
accepts step and remains under **Needs you**. Steps are not the run plan or a reason to add a new checklist
state. Risk is not an acknowledgement request: anything the reader must answer or acknowledge still goes
through `ask`. Checks, decisions, commits, status and activity stay in their existing sources. Preserve the
failed-check summary and the details in **The record**. Use a proof block in place of the same artifact's
automatic thumbnail, not in addition to it. Keep Files as the inventory, and keep a caption readable even
for an unavailable file.

### Layouts this fits

Build a section renderer, not a new task shell. `TaskSheet.svelte` already places report content in Needs
you, What you get, Not done and Next; `task-details.ts` provides section and review decisions. Reuse those
slots and the existing proof, Files, review and reply controls. Android's `TaskDetails.kt`/`TaskSheet.kt`
should use the same section rules and native rendering. Preserve section heading anchors, selection/quoting
and source order; do not make color, hover or a tab switch the only route to important content. In review,
preserve the existing single placement of legacy Next text under Check the work. Typed Next stays for agents
and never supplies the review instructions; typed manual actions come from Your steps.

- **Gemini:** the Broadsheet can put findings beside selected proof, the Cockpit can put the same sections
  in its middle pane, and the Narrative Atlas can deep-link from the chapter spine to those sections.
  Neither pane size nor scroll model enters the report schema.
- **Fable:** Route uses Arrived for outcomes and Ahead for gaps and next actions. Front page can style the
  same findings as an editorial column; Orbit can put them in its Result pane or phone tab. The plan
  rail/dial remains Live, not a report-writing primitive.
- Keep the current sheet as a supported host. Evaluate one shared synthetic report at narrow, sheet and wide
  widths, light/dark, with keyboard or TalkBack and enlarged text. No need to pick a proposal before
  shipping blocks.

## Authoring and storage

Add optional `report.blocks`, keyed by `summary`, `results`, `notDone`, `next`, `steps`, to the live and
snapshot report types in `packages/protocol/src/board.ts`. Advertise `task-report-blocks` in
`hello.features`. When a section has typed content, it is authoritative and the server writes a
deterministic Markdown mirror to the existing field in the same transaction. Keep mirrors even when there
are no known older clients: they carry all report facts, step numbering and exact copy text to history/diff
readers, agent tools and existing checks. Escape labels and literal values, use safe Markdown links and
generate code fences that cannot be closed by the snippet. Never include raw HTML or signed URLs. Render
either blocks or the mirror, never both. Keep blocks and mirrors out of the task revision used for ordinary
edits.

| Writer | Proposed tool shape and write rules |
| --- | --- |
| Coordinator and background coordinator, `board` action `write_report` | Keep `id`, current string sections, `checks`, `coveredEventSeq`, `waitsOn` and `milestone`. Add `blocks: { summary?, results?, notDone?, next?, steps? }`, each present key a complete ordered list. Omit to preserve, send `[]` to clear. Old string writes remain valid and replace just that section, clearing its typed data. Reject a string and blocks for the same section in one call; mixing formats across sections is fine. Checks still replace the whole list. |
| Native or official worker, `task_progress` | Add `addResultBlocks: ResultBlock[]` (1–8 per call), mutually exclusive with `addResult`. Append in order only to assigned Results. Keep `now`, `checks` (merge by name), `plan`, `tick`, `coveredEventSeq` and `milestone`. A call without an update still reads the assigned task and its `eventSeq`. No authority to rewrite the other sections, attach a section view, or ask on the board. |

Allow up to 64 typed blocks per section and 32 KiB of typed payload per report write as starting transport
limits. Bound `setup` to eight pairs and validate useful nonblank fields and section/kind combinations. Do
not silently truncate. A long but necessary procedure can use a complete numbered legacy Markdown section if
the typed transport envelope cannot hold it. Structural and scope errors fail before any write; writing
style warnings never fail a save. Resolve artifact references within the same project and task. Let
server-side reports and snapshots retain the reference, not a URL.

When a typed worker append hits existing Markdown, keep the exact old Results as a server-owned Markdown
prefix, then add typed rows without guessing what the prior text meant. Migrate that prefix only on a
coordinator rewrite. When an old worker appends to typed Results, adapt a simple `addResult` bullet to one
outcome; preserve complex Markdown as a server-owned segment in append order. Neither form may erase
existing blocks. Preserve retry deduplication with the durable tool call key; retain the adjacent-repeat
guard for legacy bullets and use the normalized appended block sequence for typed repeats. Derive worker
Live lines from short outcome/finding text, not a dump of setup or proof. Validate and write both input
shapes through `writeReportIn` in `board.ts`; return readable typed fields and any attached view
label/version from `show_task` and the worker read path without fetching artifact bytes. Keep the compact
board list compact.

The official-agent MCP bridge (`official-agents/mcp-worker-tools.ts`) already imports
`workerTaskProgressTool` for its schema and invokes `workerTaskProgress` for writes. Add the input there by
extending the shared source, not a second MCP-only schema. Keep the bridge's strict argument checks,
assigned-task scope, current-run guard inside the transaction and artifact path restrictions. Its
`artifact_save` assigns the task and returns the retained version; workers can cite that as proof, or give
it to a coordinator for a section view. Test native, code-mode and official-agent MCP calls against the same
Results behavior and style warnings. Do not expose the coordinator's board tool on the worker bridge.

### Prompt and warnings

Extend the shared `WRITING_RULE`/`REPORT_RULES`, background task instructions and native/official worker
prompts in `workers.ts` and `threads.ts`, plus tool descriptions. Suggested text:

> Start with what changed for the reader. Pick one block for each fact. Name a finding, then say what held
> or didn't. Put conditions in Setup and explain what a saved file proves rather than listing paths. Write
> what is missing in Not done. In Next say what agents will do. In Your steps number every manual action,
> start with a verb, and preserve exact values and copyable commands. If a table or diagram would help,
> attach a view after putting the conclusions in blocks. Never put required facts only in the view or chat.

Keep T288: whole sentences with verbs and small words, around 20 words to a prose line, no semicolon chains,
names not bare IDs, and no repeats of status, decisions, questions or files. Leave revision IDs, paths,
worker names and check counts to the record; keep trailers and `artifact_save` task attribution. Don't
shorten a complete answer or manual action to hit a word count. Questions still begin with the ask and use
choices for effects; substantial feedback answers still go in the feedback note. A chat reply can briefly
point to the task.

Extend `task-text-style.ts` and the successful tool replies together. Inspect submitted prose fields, not
JSON or mirrors counted twice. Keep the existing over-30-word line and likely revision-ID checks. For legacy
sections detect a paragraph over 60 prose words even when source lines are softly wrapped; for blocks detect
an overlong body or an embedded list of facts and suggest splitting blocks. Example: `Results, “The
rehearsal ran…”: Split this paragraph into a finding, setup and proof.` Prefer one actionable diagnostic to
two for the same passage, with the existing cap of three style diagnostics. Reuse code/URL masking; don't
treat fenced or inline code, tables, exact copy text or pairs of setup values as paragraph prose. Preserve
the separate “detail only in chat” pointer warning. No bulk rewrite, edit on read or model in the warning
path.

## Old reports and mixed versions

Start with read-time formatting only, test the same fixtures on web and Android, and leave the stored text
untouched. Use a Markdown parser or conservative block detection, not a regex split on every colon or
newline.

1. Keep paragraphs, headings, links, code fences, quotes, tables, nested lists and numbered steps in the
   existing safe Markdown renderer. In particular, bypass today's one-item-per-line Not done conversion when
   Markdown structure is present.
2. Simple flat bullets become spaced rows with no inferred pass/fail or outcome status. Plain flat Not done
   lines can become a list. Consecutive `Label: text` lines can become labeled rows if labels are short,
   values nonempty and none of the lines have nested Markdown structure. Accept unambiguous labels only;
   leave a URL, time, code, or ambiguous colon as written. Do not infer a finding, check, artifact link or
   meaning from a label. The original text stays available for history and quoting.
3. Keep an undifferentiated paragraph intact, at comfortable line width. Do not split on sentences, hard
   wraps, semicolons or apparent words like “Proof:” mid-sentence. The paragraph warning and a later
   authored rewrite fix the 400-word case; automatic formatting does not pretend to understand it.

Old server/new client uses the legacy renderer without typed claims. New server/old client sees only the
familiar mirrors and Files behavior. Review wire compatibility with old clients, including Android generated
decoders, snapshots and history diff. Decode the optional typed payload separately from the base report so a
future/unknown kind or malformed typed section falls back to the whole section's mirror, not a partially
dropped report or an undecodable board response. This must hold before enabling writes. Turning off the UI
capability should not erase stored blocks or count as rewriting the report.

## Optional HTML section view

Start with Results and Not done only, behind `task-report-section-views`. A section gets at most one view,
for an actual table, diagram or visual comparison. No HTML-only sections, ordinary paragraph replacements,
manual steps, decisions or controls. Keep the headline, conclusions, gaps and necessary numbers in the
report; attach a full standalone artifact instead for long-form, interactive or multi-page work. This is the
same design language as the `html-artifacts` skill, with a stricter execution policy.

- **Storage and authoring.** Use `artifact_save` with the task, then `board.write_report.sectionViews` keyed
  by `results` or `notDone`. Each key takes `{ artifactId, version, label }` or `null` to detach; omitted
  keys preserve an existing attachment only while its section content is unchanged. Validate the exact
  version, task/project scope, HTML media type and size, and require an existing or same-write set of
  meaningful typed blocks. A substantive section edit or worker append without an explicit replacement
  detaches its view; the file remains in Files. An HTML-only attachment change can update report revision
  and a named snapshot, not text freshness. Store the pinned pointer in live and snapshot reports, not a
  second copy of HTML. Reasons: the artifact store already has scoped access, retention, versioning, review
  and deletion. A pruned/deleted/failed version shows “View unavailable” with the blocks intact. Do not
  substitute latest or add indefinite retention in v1.
- **Web presentation.** Show the native section first and a labeled button such as “Open comparison table”.
  Opening expands a bounded preview with a larger artifact-style dialog available; do not mount a frame per
  section until asked. The frame has a descriptive title, keyboard access, a reliable way back and no
  host-page horizontal overflow. Use the existing signed bounded fetch and theme injection, but a
  **different policy** from the general artifact viewer: UTF-8 static HTML in an opaque-origin `srcdoc`
  iframe with an empty sandbox, no referrer, no scripts, no forms, no popups, no same-origin grant, no
  parent messaging and no external navigation. Parse with a maintained allowlist before rendering, removing
  scripts, event attributes, embedded documents, navigation/refresh, unapproved URLs and active SVG. Start
  with semantic HTML, static SVG shapes and safe inline CSS; allow only local fragment references and
  bounded embedded raster images. Inject restrictive first-in-head CSP as a second layer (`default-src
  'none'`, no connections or external assets, allow only inline CSS and permitted data images, forbid forms
  and base URLs). Never insert HTML into the host DOM or preview via an app-origin blob. Both section
  preview sizes use the same policy; the general Files viewer is not the section preview.
- **Theme and limits.** Inject only the existing app-owned `--tone-*`, `--font-*`, `--text-task*` and
  `--spacing` allowlist, `data-theme` and `color-scheme` as low-priority defaults. Supply a static
  table/diagram template with semantic headings, row/column labels, alt text, theme contrast and a
  print-friendly layout; do not inherit the skill's optional CDN/script features. Start at **256 KiB of
  source UTF-8 bytes**, including embedded images; check at attachment and on fetch even if a range is
  ignored. Also cap rendered complexity (starting budget 2,000 nodes, depth 32; bound embedded-image pixel
  dimensions). Over-limit or invalid content is never partially rendered. Defer larger detail to a normal
  artifact. Test that no network or navigation occurs from the frame, that malformed markup cannot bypass
  policy, and that failures and dark/light changes never remove the native report.
- **Android.** No inline WebView in the task sheet. Native blocks and caption are the default. For the first
  release keep a labeled file entry/download when the pinned version is available; if a read-only “Open
  view” route is added later, reuse the artifact screen's chrome only with an equally strict, network-off,
  no-script, no-bridge policy. Do not silently pass a section attachment to the more permissive general
  WebView. Missing, unsupported and oversized views leave the same readable section. Older Android sees the
  mirrors and ordinary Files only.

## Freshness, history and the end-of-turn check

Only Results and Next have coverage (`task-freshness`); keep it that way. Derive a stable comparison from
the section's readable facts: text, numbers, meaningful labels, order and exact commands when relevant, not
padding, CSS, artifact identifiers alone or generated Markdown decoration. Use one comparison in both
`writeReportIn`'s milestone invalidation and `writeReport`'s call to `coverReportSection`. Preserve legacy
prose behavior; do not count an equivalent legacy-to-block conversion, a repeat, a visual-only change or a
read-time restyle as covering new facts. Compare meaningful typed edits even if flat fallbacks render
similarly. Extend snapshot diff to show structural/attachment changes without presenting them as new
outcomes. Keep exact pinned references with the history; old snapshots still render.

Default substantive writes cover the sequence at write time. With explicit `coveredEventSeq`, clamp to the
current sequence, never regress coverage, and keep newer unseen facts stale. Preserve Next's `waitsOn`,
worker milestone exceptions, one-nudge/dedup behavior, closed-task rules, the empty finished-Results gap and
the **Report may be out of date** line with its update request. Summary, Not done, steps, HTML, checks and
automatic Now must not refresh Results/Next by themselves. Audits and agent reads can keep using readable
projections, not HTML; stable report comparison must not weaken existing fact invalidation or rearm nudges
on retries.

The only-in-chat check runs at the end of a coordinator turn started by client chat, not harness-started or
worker turns. Keep the existing exact-command checks, numbered-step coverage, word overlap with numeric
agreement, substantial-prose threshold, task scopes, feedback/question exceptions and `[reports]` route. In
`board.ts`, feed `#checkChatDetail` the report's readable projection exactly once; preserve list and command
boundaries so code matching still works. Extend `recordChatDetailWrite`/`countTaskWrite` to meter submitted
typed prose and exact steps in the successful board transaction, including code-mode writes, without
counting JSON, labels alone, refs, mirrors twice or HTML bytes. Do not credit an attachment-only write or an
empty clear as filing detail. The check does not scan task files today and should not start. A required
instruction present only in HTML still belongs in Your steps; a missing finding still belongs in Results.

## Delivery stages

Estimates are focused person-days, including tests, not a task-sheet redesign. Each stage has a visible
result before the next one ships.

| Stage | Rough size | What changes for the reader and how to check it |
| --- | --- | --- |
| 1. Legacy readability and warnings | 2–3 days, server + both apps | Old lists and labeled lines gain shape without rewriting history. Agents get useful warnings on new walls of text. Run shared Markdown and warning fixtures, including a fence, wrapped paragraph and a numbered procedure. |
| 2. Typed reports on web | 4–6 days, protocol + server + web | Newly written Results read as findings, setup and proof rather than a paragraph. Summary, gaps, Next and steps each get their own shape. The fallback remains readable on old clients. Verify write/clear/append/retry, official MCP parity, snapshot/diff, freshness and only-in-chat cases before enabling writers. Show before/after with the long paragraph rewritten and with an old report untouched. |
| 3. Native blocks on Android | 2–3 days, Android | The same report is scannable on the phone, with copyable steps, visible proof and no embedded browser. Regenerate protocol models, exercise old/new and unknown kinds, and check large type, TalkBack and a narrow screen. |
| 4. Strict HTML section views | 3–5 days, server + web + Android fallback | Open a comparison table or diagram beside the report without losing the findings. Verify task scope, version pinning, pruning, denied network/navigation, size limits, themes and readable fallback. No interactive document support in this stage. |

For review, pair the synthetic capacity rehearsal with a non-software example that has no files, and with an
example containing real manual steps and a stale report. Include empty, active, review and settled states.
Capture proof for representative layouts rather than rebuilding all six proposals. After rollout, compare
paragraph-warning rates and the share of Results with a clear lead or titled finding; inspect samples for
repeated facts and missing steps, not word count alone.

## Open decisions before building

1. Ship typed web reports as soon as the Markdown fallback is verified, or enable typed writes only once the
   Android renderer ships? Recommend web first.
2. Start with static HTML in Results and Not done and a native Android fallback, or require a dedicated safe
   Android view in the first HTML release? Recommend the fallback first.
3. Is artifact retention with a clear unavailable state enough for historical section views, or must
   referenced versions survive the normal prune limit? Recommend normal retention until there is a concrete
   history requirement.

## References

- [As-built design](../DESIGN.md): “Tasks as the place to read,” “Report freshness,” “The record,” and the
  artifact viewer/privacy sections.
- [Task details rethink](task-details-rethink.md): reading order, writing rules and the record.
- Current seams: protocol `board.ts`; server `board.ts`, `worker-task-progress.ts`, `task-text-style.ts`,
  `task-freshness.ts`, `report-audit.ts` and the official-agent MCP bridge; web `TaskSheet.svelte`,
  `TaskProof.svelte` and `artifact-page.ts`; Android `TaskDetails.kt`, `TaskSheet.kt` and the artifact
  screen.
- Layout proposals reviewed: Gemini's Broadsheet, Cockpit and Narrative Atlas; Fable's Route, Front page and
  Orbit. These are layout alternatives, not report formats.
