# Subscription value and per-task usage (T321)

Design and staged plan. Nothing here is built. Mockups with synthetic data are saved as an artifact on the task.

## The question

The owner pays a flat price for each subscription and wants to see what that buys:

- how much the tokens Kemiri used would have cost at API prices;
- how much of the subscription's limit those tokens consumed;
- from both, what a full limit window is worth and how many times the price the subscription pays back;
- the same API-priced cost and limit use per board task, rolled up through its subtasks.

## What exists

- **Request log** (`request-log.sqlite`, 90 days). One row per model response with provider, model, token counts, the
  catalog-price cost and its parts, the conversation's kind, worker, thread, schedule and board task, and a `purpose`
  for internal calls (compaction, memory, report audit). Keep-warm calls are rows with their own source.
- **Catalog prices.** pi-ai's `calculateCost` prices every response from the model's `cost` table, including
  long-context tiers and the one-hour cache-write rate. The row keeps the price as it was when the request ran.
- **Subscription usage** (`subscription-usage.ts`). Per provider login: windows with `usedPercent`, `resetsAt` and
  `windowMinutes`, and samples for the current period only. Samples are dropped when the window resets, so there is no
  history of limit use.
- **Usage modal** (web): Overview, By role, By model, Projects & tasks, Waste, with a Today / 7 days / 30 days picker.
  Android has one usage screen with the limit gauges, reset credits and the cache section, without tabs.
- **Task links.** A board task has at most one `parent`, and `subtasks` is derived from it. `foundWhile` / `ledTo` is a
  looser "discovered while working on" link.

Three gaps matter for this design:

1. A request row does not say how it was paid for. `anthropic` can be an OAuth login (subscription) or an API key
   (real money). Today only the stored credential's current type tells them apart.
2. Only workers and threads carry a board task. The coordinator's own requests have none. A worker's identity is cached
   the first time it is known, so a worker reassigned to another task keeps logging to the first one.
3. The T78 analysis stated "never convert token share to quota share". This design does convert, but from measured
   movements of the provider's own percentage, and it labels every such number as an estimate with its range.

## What each provider exposes

| Provider | Windows | Source | Resolution | Notes |
| --- | --- | --- | --- | --- |
| Claude (OAuth) | 5-hour, weekly, weekly per model or surface | Usage endpoint, and headers on every reply for the 5-hour and weekly windows | Whole points | Scoped windows come from the endpoint only. Manual reset credits can empty a window early. |
| ChatGPT / Codex (OAuth) | Primary and secondary (length reported, plan dependent), extra metered limits | Usage endpoint, headers over SSE, a stream event over WebSocket | Whole points | Some plans report one weekly window only. |
| OpenCode Go (plan API key) | Rolling 5-hour, weekly, monthly | Usage endpoint only, no headers | Whole points of the plan's dollar limits | The percentage is already money-based. |
| Other OAuth logins | None | None | — | Tokens and catalog price only. |
| Pay-as-you-go API keys | None, by nature | None | — | The catalog price is roughly the real bill. |
| Official-agent workers (T304) | Not machine readable | The agent's own token counters | — | See "Official-agent workers". |

No provider reports a plan's price, the limit in tokens or dollars, or what one request cost against the limit. The
percentage is account-wide: it includes the provider's own apps and CLIs used with the same login.

## The numbers

All money is USD at catalog (API) prices.

| Name | Meaning | Kind |
| --- | --- | --- |
| **API value** | Sum of the catalog cost of the requests paid by this subscription. | Measured. Rows can be dropped, and a model without a catalog price counts as "unpriced". |
| **Limit used** | Points of a window (1 point = 1% of it) the provider reports as used. | Measured by the provider, whole points, all clients. |
| **Kemiri's points** | The part of "limit used" that moved while Kemiri's requests were finishing. | Estimate. |
| **Used elsewhere** | Points that moved while Kemiri was idle, or that were there before Kemiri's first reading. | Estimate. |
| **Value per point** | API value ÷ Kemiri's points, pooled over periods. | Estimate with a range. |
| **Full-window value** | Value per point × 100. "A full Claude week is worth about $610." | Estimate with a range. |
| **Subsidy, realised** | API value in a calendar month ÷ the monthly price the owner entered. | Measured value over an entered price. |
| **Subsidy, at full use** | Full-window value of the binding window × windows per month ÷ monthly price. | Estimate, a ceiling. |
| **Plan used** | Realised ÷ at full use: how much of what the plan allowed was taken. | Estimate. |

The **binding window** of a subscription is its longest unscoped window (weekly for Claude and ChatGPT, monthly for
OpenCode Go). It caps what a month can hold. Shorter windows only pace the use, so they get a full-window value but no
monthly ratio. Windows per month is 30.44 days ÷ the window's length.

### Per model

- API value per model is measured.
- The limit share per model is not reported. By default each period's Kemiri points are split by API value, so every
  model shows the subscription's own value per point. The UI then says "not measured separately" instead of repeating
  the same ratio per model.
- A scoped window (Claude's "Weekly · <model>") is a direct measurement for that model and gets its own value per
  point.
- Later (stage 6) a fit over many short periods estimates each model's weight. For closed 5-hour periods `i`, fit
  `points_i = Σ_m w_m × value_{m,i}` with non-negative least squares. A model's weight is shown only when it has data in
  at least 12 periods and leaving out any one period moves it by less than 25%. Otherwise it stays "not measured
  separately".

## Attributing limit use to requests

### Recording

Every reading of a window (endpoint read, reply header, stream event) goes to a ledger before today's 60-second
collapsing. Only a changed value or a changed reset time adds a row, plus the last reading of a flat run. A reading
belongs to a **period**: one stretch of a window between two resets. A period ends when the reading time passes
`resetsAt`, when `resetsAt` moves by more than five minutes, or when the percentage drops (a manual reset, or a
rolling window sliding).

Each request row gains how it was paid (`billing`) and the binding-window period that was open when it ran.

### Splitting a period

Between two consecutive readings of a period, the percentage moved by Δ ≥ 0.

- A request belongs to the interval in which it **ended** (start time plus duration). Providers count a request after
  it completes, and a reply's headers show the level before that reply's own tokens.
- Δ in an interval with at least one request that ended in it, or within two minutes before it, is **Kemiri's**.
- Δ in an interval without one is **used elsewhere**. The reading before a quiet stretch comes from the read that
  follows a turn. The reading after it comes from the first reply of the next turn. So a jump across a quiet stretch
  is seen without extra polling.
- The level at the period's first reading is **used elsewhere**: nothing was observed before it.

Within a period, Kemiri's points are shared between requests in proportion to their API value. A task's share of a
window is therefore `task value in the period ÷ value per point of that period`. Requests are not matched to single
one-point steps: one step is far coarser than one request.

### Error and noise

- **Rounding.** Readings are whole points. A period's Kemiri points are off by up to one point. On a large plan one
  weekly point is several dollars of API value, and a small task is a fraction of a point. Pooling `n` periods gives
  an error of about `max(1, 0.6 × √n)` points. The range shown is value ÷ (points ± that error).
- **Minimum evidence.** No value per point is shown below 5 pooled Kemiri points. The UI says "not enough use yet".
- **Use elsewhere at the same time.** If another client uses the login while Kemiri works, its points are counted as
  Kemiri's. This makes the value per point too low, never too high. Periods where "used elsewhere" is above 10% of the
  period are left out of the pooled estimate when at least three cleaner periods exist, and the tab names the share
  used elsewhere.
- **Provider weighting.** Providers may weigh models, cache reads or long prompts differently from their API prices.
  The value per point then depends on the mix of work. The pooled figure is for the owner's actual mix.
- **Timing.** Accounting can lag a reply. Requests near an interval's edge may land in the neighbour. This matters for
  nothing above a period, because shares inside a period use the period's totals.
- **Gaps.** While the backend is down, requests elsewhere and resets are not seen. The first reading after a start
  opens with its level as "used elsewhere".
- **OpenCode Go.** No headers, so readings come only after turns and every five minutes while a client is connected.
  A jump while Kemiri was idle can fall into the next busy interval and count as Kemiri's.
- **Not measured at all.** Requests that failed without returning usage, a worker's own fallback compaction, and paid
  overage beyond 100% of a window.

## Data model and storage

Everything lives in `request-log.sqlite`, schema 3. Old writers refuse a newer schema, as they already do.

`requests` gains:

- `billing TEXT`: `subscription` (OAuth login), `plan_key` (an API key that is a plan with limits), `api_key`
  (pay-as-you-go), `agent` (an official-agent worker), null for rows written before this column.
- `period_id INTEGER`: the open period of the provider's binding window, null when there is none.
- `priced INTEGER`: 0 when the model has no catalog price, so a zero cost is not read as free.

`billing` is read from the credential type of the request's provider when the row is written. Rows with null billing
count as the provider's current credential type, and the tab marks months that contain them as "assumed".

New tables:

```sql
-- One row per change of a window's reading.
limit_samples(id, at, provider, window_id, period_id, used_percent, resets_at, source)
-- One row per period of a window. Totals are refreshed while open and frozen when it closes.
limit_periods(id, provider, window_id, label, window_minutes, scope, started_at, resets_at, ended_at, end_reason,
              first_percent, last_percent, kemiri_points, elsewhere_points, api_value, requests)
-- What a provider login was over time: plan label, credential type, entered price.
subscription_terms(provider, since, plan, credential_type, monthly_price)
-- Totals that outlive the 90-day request rows.
usage_rollup(day, project_id, task_id, worker_id, thread_id, role, provider, model, billing, period_id,
             requests, input, cache_read, cache_write, output, cost, unpriced_requests,
             PRIMARY KEY (all the grouping columns))
```

- `usage_rollup` is updated in the same transaction as each inserted request and never pruned. A project's rows go when
  the project is deleted. The backfill of old transcripts fills it for rows already in the log, once.
- `limit_samples` is pruned with the request rows (90 days). `limit_periods` and `subscription_terms` are kept.
- `scope` on a period holds the model or surface of a scoped window, null otherwise.
- The live `subscription-usage.json` and the `subscriptions.usage` wire shape stay as they are.

The server takes readings through one seam: the usage service calls `ledger.reading(provider, window, at)` wherever it
applies a reading today. Nothing provider-specific enters the ledger.

## Per-task roll-ups

- A task's **own** usage is every roll-up row with its project and task ID: its workers and its threads, whatever
  models and subscriptions they used.
- A task's **total** is its own plus the totals of its subtasks (`parent` links), computed when asked from the board as
  it is then. Moving a subtask moves its cost. Archived subtasks still count.
- `ledTo` tasks are not included. They are separate work that happens to share an origin.
- Limit share per task: for each subscription, `Σ over periods (task value in period ÷ period's value per point)`,
  shown as a share of one binding window ("≈ 7% of a Claude week"). When the period has under 5 Kemiri points, the
  pooled value per point of the subscription is used. With no estimate at all, only the API value shows.
- The coordinator's requests have no task. They show as one "Coordinator" line per project, not spread over tasks.
- Fix that goes with this: the cached conversation identity is dropped when a worker's task changes, so a reassigned
  worker logs to its new task.
- Scheduled runs keep their schedule and count for a task only when the worker or thread they start has one.

## What a task shows

In the task's detail sheet, one line under the report, only when the task or its parts have recorded requests:

> **$41.80 at API prices** · ≈ 7% of a Claude week · 3 workers, 2 subtasks

It opens to:

- "This task" and "Subtasks" as two amounts, then one row per subtask with its total (a tree, same order as the board);
- by subscription: API value, the estimated share of its binding window, and "paid for by subscription";
- "Paid at API prices: $0.62" when pay-as-you-go keys were used, as real money, never mixed into the subsidy;
- by worker or thread: name, model, API value;
- a note when requests were unpriced or the limit share is missing.

Board cards do not change in the first version. Amounts are fetched when the sheet opens, not carried on board pushes,
so the board does not change with every request.

## The usage panel

A new **Value** tab, second after Overview. It uses calendar months, not the 1 / 7 / 30-day picker, because prices are
monthly. A month picker replaces the period picker on this tab.

Per subscription, one card that reads top to bottom:

1. The headline sentence: "**$1,640 of work for $100.** 16× what this subscription costs."
2. Two bars on one scale: what was paid, and the API value used. A faint third bar: the value at full use.
3. Three small facts: plan used this month (62%), what a full week is worth ($610, range $560–$670), points used
   elsewhere (8%).
4. Models: one bar per model with its API value, and its own value per point only when measured.
5. "Where it went": the top tasks by total, with subtasks rolled up, each linking to its task.
6. A plain footnote: what is measured, what is estimated, since when.

Below the cards:

- **Paid at API prices**: one row per pay-as-you-go key with the month's catalog cost. No ratio.
- **No limit reported**: subscriptions without windows show API value and, with a price, the realised ratio only.
- A subscription without a price shows "Add what you pay" in place of the ratio. Everything else still shows.

On Android the usage screen gets a two-part switch at the top, "Limits" and "Value". "Value" has the same cards in one
column: headline, the bars, the three facts, models, top tasks. The task sheet gets the same line and breakdown.

### Wire

Feature `subscription-value`. Clients without it keep today's screens.

- `usage.value { month?, utcOffsetMinutes }` answers one entry per subscription (label, plan, billing, price, API value,
  realised ratio, per window the pooled value per point with its range and evidence, plan used, used elsewhere, models,
  top tasks, whether the month has assumed rows), the pay-as-you-go rows, the unpriced count and the ledger's start.
- `subscriptions.price.set { providerId, monthlyPrice | null }` stores the owner's price from now on.
- `usage.task { projectId, taskId }` answers own, total, parts, by subscription, by worker, pay-as-you-go and notes.

## Special cases

- **No usage endpoint.** The subscription has no windows, so there are no points. API value and the realised ratio
  still work. Nothing is guessed.
- **API keys.** `billing = api_key`. The catalog cost is shown as money spent. A request never counts toward a
  subscription because its provider also has a login somewhere else: the credential used decides.
- **Plan keys (OpenCode Go).** Treated as a subscription. Its percentage is of dollar limits, so the full-window value
  estimates the plan's dollar allowance at catalog prices.
- **Manual resets.** A drop ends the period with `end_reason = manual_reset` when a reset credit was spent through
  Kemiri, else `drop`. The emptied period keeps its points. The month simply holds more periods.
- **Plan or login change.** A new `subscription_terms` row. Estimates pool only periods under the same plan.
- **Several backends.** Each backend has its own logins and ledger. The tab shows them per backend, as it does now.
- **Official-agent workers (T304).** They make no pi-ai requests, so nothing reaches the request log on its own. The
  worker adapter reports a turn's token counts (its counters are cumulative, so the adapter reports deltas). Kemiri
  writes one row per turn with `billing = agent`, the worker's task, and the provider and model the agent names. The
  row is priced only when the adapter maps the model to a catalog model exactly, else it is `priced = 0`. No rates are
  guessed. The agent's plan view is not machine readable, so the subscription shows as "no limit reported". If an
  adapter can later read its quota reliably, it feeds the same `ledger.reading` seam and everything above works.
- **Generic by design.** Providers differ only in who supplies readings and how a request was paid. No provider name
  appears in the ledger, the roll-up, the wire types or the UI code beyond the labels the usage service already has.

## Staged plan

Each stage is one worker's job, in order. Stages 3 and 4 can run side by side after stage 2.
Every stage runs the root tests and `bun run typecheck`. A stage that touches the protocol also regenerates the
Android models and runs the Android build. A stage that touches `apps/web` runs its check, tests and build.
`docs/DESIGN.md` is updated in each stage's commit.

### Stage 1: record how requests were paid and the limit ledger (server)

- Schema 3: `billing`, `period_id`, `priced` on `requests`, and the four tables. Opening a schema-2 log migrates it.
- Billing from the credential type when the row is written. Periods opened, continued and closed from readings.
- `usage_rollup` kept on insert, filled once for existing rows.
- The usage service passes every reading to the ledger. No behaviour visible to clients changes.
- Checks: unit tests with a fake clock and fake readings for a reset by time, a moved reset time, a drop, a restart in
  the middle of a period, a flat run, and a reading before any request. A test that an API-key provider's rows are
  `api_key` and an OAuth one's `subscription`. A migration test from a schema-2 file. A test that pruning requests
  leaves the roll-up totals unchanged.

### Stage 2: the value numbers and their wire types (server, protocol)

- Splitting periods into Kemiri's points and used elsewhere. Pooled value per point with range and minimum evidence.
  Realised ratio, ratio at full use, plan used. Per-model values. Scoped windows as direct per-model figures.
- `usage.value`, `subscriptions.price.set`, feature `subscription-value`, `subscription_terms`.
- Checks: table-driven tests of the split (request ends in the interval, ends just before, idle jump, first reading
  above zero). Tests of the range and of "not enough use yet" under 5 points. A test that noisy periods are left out
  only when three cleaner ones exist. A test with no windows, one with an API key, one with no price. Protocol
  round-trip tests. The Android model generation and build.

### Stage 3: the Value tab on web

- The tab, the month picker, the cards, the price entry, the pay-as-you-go and no-limit sections, old-backend fallback.
- A demo fixture script that seeds a request log, periods and prices with synthetic data.
- Checks: component and wording tests. Keyboard order through the tabs still works. Proof: before and after
  screenshots on desktop and phone widths in light and dark, and a short recording of opening the tab, changing the
  month and entering a price.

### Stage 4: task usage (server, protocol, web)

- `usage.task` with the roll-up through subtasks. The identity cache fix for reassigned workers.
- The line and its breakdown in the web task sheet.
- Checks: tests for own and total across three levels, an archived subtask, a moved subtask, a `ledTo` task left out, a
  reassigned worker, a task with only pay-as-you-go requests, a task with no requests (no line). Proof: before and
  after screenshots of a task with subtasks on desktop and phone, and a recording of opening the breakdown.

### Stage 5: Android

- The "Limits / Value" switch, the Value cards, the price entry, the task line and breakdown.
- Checks: unit tests for the formatting and the state holder. Emulator proof: before and after screenshots of the usage
  screen and a task, in light and dark, and a recording of both.

### Stage 6: later, each on its own

- Per-model weights from the fit over 5-hour periods.
- Usage rows from official-agent workers, once T304's adapter exists.
- An optional estimate that spreads the coordinator's cost over the tasks whose reports and messages woke it.

## Choices for the owner

1. **Prices.** The owner types each subscription's monthly price in USD (recommended), or Kemiri ships a list of known
   plan prices that the owner can correct. A shipped list goes stale and is wrong for taxes and regional prices.
2. **Headline.** Lead with the realised ratio, "16× what it costs this month" (recommended), with the ratio at full use
   as the faint bar. Or lead with the ceiling.
3. **Coordinator cost.** Keep it as one line per project (recommended), or spread an estimate over tasks later.
4. **Board cards.** Show the cost only in the task sheet (recommended), or also as a small amount on each card.
5. **Related tasks.** Roll up subtasks only (recommended), or also the tasks a task led to.
