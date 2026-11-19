# A task that follows the work (T305)

Research and a proposal; nothing here is built. It applies to any project. The mockups and a scripted replay
are in `live-task-content-prototype.html` beside this file (one HTML file, synthetic data, no build step, no
network).

## Summary

A task is meant to be the owner's window onto the work: a filter between the raw chat and the reader. Today
the window shows a state and, at the end, an outcome. It does not show the work in between.

- The page has two grains only. **Now** is one line that replaces itself. **What you get** describes the end.
  The steps between them have no place.
- The harness already records every step of every agent. Almost none of it reaches the task.
- The proposal is one **Live** block on a working task. It says what is happening now, how far along the plan
  is, and what happened so far.
- Three writers fill it, and the page keeps them apart: facts the harness records, the agent's own words, and
  short automatic summaries from a small model.
- The facts and the plan cost no tokens. A small model that reads all the work of the measured project would
  cost about 5 cents a day. Keeping reports current costs the big models several dollars a day now.

## What exists today

- **Automatic Now (T122).** A reducer picks one line from durable facts: a failure, an open question, a live
  worker, a wait, a delivery. It costs nothing and is always true. A worker can set a short phase, which
  replaces the previous one and leaves no trail. That was a choice, to keep clutter out.
- **Freshness and nudges (T121).** Results and Next carry what they cover. When facts pass a section by, it is
  marked and the coordinator gets one batched `[reports]` line asking for a rewrite.
- **The small-model check (T126).** At most hourly, a small model judges whether Results or Next of up to four
  tasks miss newer evidence. It answers `fine` or `stale`. It never writes on a task.
- **The task page (T285).** One column in the order of the owner's questions. A working task shows Now once.
  Activity is folded and lists starts, reports, questions and deliveries.
- **Check-ins.** Every ten minutes a coordinator with running workers gets a digest of what each did last
  (`describeWorkerActivity`). Its judgement goes to the chat or nowhere.

## What was measured

One busy project over five and a half days, read from its board and its stored transcripts. Counts only:
124 worker runs of five active minutes or more, 52 hours of active worker time, 9,652 worker tool calls, and
18 coordinator conversations. Money is what the project's request log recorded.

How often the task moves:

- **A typical run is 21 active minutes and 66 tool calls.** In that time the worker writes on the task four
  times: three result lines and two phase changes, some in one call.
- **The longest stretch with nothing new on the task is 11.7 minutes at the median**, with 31 model turns
  inside it. It is ten minutes or more in 73 of 124 runs, twenty or more in 21, and 46 at the longest.
- **A third of active time shows the title only.** Now then reads "fern is working on" and the worker's title.
- **A phase is three words at the median** and stays 6.6 minutes.
- **Results come at the end.** 42% of worker result lines are written in the last 15% of the run's active
  time.
- **Worker lines were a work log.** Median 31 words; half held a commit hash. The writing rules of T285 are
  new: the ten lines written after them have a median of 20 words and no hash.

Where the rest goes:

- **The coordinator's view goes to the chat.** 284 check-ins led to 247 chat replies and 5 report writes. In
  all, coordinators wrote 1,243 chat replies and 612 report writes.
- **The harness sees far more than the page shows.** Every tool call with its arguments, every file edited or
  saved, every commit, and 5,742 thinking summaries on the workers alone.
- **A worker that is handed work for a second task** keeps showing on the first. The second task shows
  nothing until the coordinator writes its report.

What keeping tasks current costs the big models (total model spend in the period: about 544 dollars):

- **Nudged rewrites.** 312 coordinator turns were started by a `[reports]` line. They cost 41 dollars, 16% of
  coordinator spend, and produced 259 report writes.
- **Check-ins.** 284 coordinator turns, 22 dollars.
- **Worker progress calls.** 443 calls, 419 of them alone in their request at about 100,000 tokens of context:
  about 2 cents each, 11 dollars together.
- **The small-model check.** 76 calls in eight days cost just over one cent. In the period it marked about 30
  sections, each followed by a big-model rewrite.
- **Mechanical causes.** 63 of 340 nudged sections were "changes landed on main", which the page already
  shows under Delivery.

## Why the page feels static

1. **Two grains, nothing between.** A state line and a final outcome. Steps have no place on the task.
2. **Now is thin and forgets.** Three words, replaced in place, title only for a third of the time.
3. **Workers write when a chunk is finished.** They go quiet exactly when they are deepest in the work.
4. **Judgement lands elsewhere.** What a coordinator concludes about running work goes to the chat.
5. **The page hides what moves.** Activity is folded and has no steps. Nothing marks what is new since the
   reader last looked.
6. **No sense of distance.** Nothing says how far along the work is.

The check and the nudges do their job: they keep the outcome sections honest. They were never meant to tell
the story of the work.

## What should be live, and at what grain

| Grain | The question it answers | How often it changes | How long it stays | Today |
|---|---|---|---|---|
| Pulse | Is it alive? What is it doing this minute? | Every step | Never stored; it replaces itself | Now, without detail |
| Steps | What has happened so far? | Every 3 to 5 minutes of work, and on events | While the work runs; then it folds into Activity | Missing |
| Plan | How far along is it? | A few times per run | Until the plan is done | Missing |
| Outcome | What do I get, what is missing, what is next? | Per run and state change | The report | What you get, Not done, Next |

The two middle rows are the gap. The outcome sections stay as they are.

## Who writes, and how far to trust it

- **The harness, from events.** The pulse (which tool runs, for how long), counters for the run, and fact
  lines: a commit recorded, a check recorded, files saved, work sent back, a failure. No tokens and always
  true. It cannot say why.
- **The worker, in passing.** A plan of three to seven steps, ticked as it goes, and a few words of intent on a
  command. It costs no extra request when it rides on a call the worker makes anyway.
- **A small model, watching.** One news sentence for every 8 to 30 steps. It can tick plan steps from evidence
  and flag a stuck worker. It can be wrong.
- **The coordinator** keeps the outcome sections. What it does to the work (checked it, sent it back) shows as
  facts.

The page keeps three marks apart:

- **Recorded:** the harness saw it happen.
- **A name:** an agent wrote it. A claim, as today.
- **Auto:** a small model read the work log. One tap shows the steps it was made from.

Rules that follow:

- Auto text never enters What you get, Not done or Next, and never puts a task under Needs you.
- "Passed", "committed" and "saved" come from recorded facts only. The watcher describes what is being done.
- An auto line without evidence IDs is dropped.

## Six approaches

A to D stack: each adds a layer to the same Live block. E and F build on D. Effort is for normal workers and
includes web and Android where the page changes.

### A. Show what we have

Keep this run's phases and result lines as a short trail. Show Now and the trail in a Live block, with a mark
for what is new since the reader last looked.

- **Effort:** 3 to 4 days. **Tokens:** none.
- **Risks:** the quiet stretches stay, because workers still write four times a run.

### B. Facts from the harness

A pulse from the running tool, counters (steps, files changed, files saved, commits, checks) and fact lines.
It uses tool names, file paths, the change ledger and saved files, never project rules, so it fits any
project. A task with no code shows no commits.

- **Effort:** about a week. **Tokens:** none.
- **Risks:** it reads like a machine log if it shows too much. It says what, never why. A failed command is
  not a fact worth a line: commands fail all the time.

### C. The worker narrates in passing

`task_progress` takes a `plan` and ticks. The command tool takes an optional `intent` of a few words. The
page shows "3 of 5" and the intent as the pulse.

- **Effort:** about a week. **Tokens:** about 12 output tokens per command; no extra requests.
- **Risks:** models forget to tick. A plan drifts and must be rewritable. A changed tool schema invalidates
  prompt caches once.
- Asking workers to report more often instead is affordable but not reliable. Tripling the calls would add
  about 5% to worker spend, and workers would still go quiet when busy.

### D. A watcher writes the news

After every few steps of a task, the harness sends a small model the new steps, clipped: tool name, a short
argument or intent, a short result tail, the model's own thinking summary, and the lines already on the page.
It answers with one sentence or with nothing.

- **Trigger:** events, not a timer. A pass runs after about eight new steps or ninety seconds of new activity,
  at most once a minute per task, at once on a failure or the end of a run. An idle task costs nothing.
- **One pass, several jobs.** The news line, plan ticks and a concern flag come from one call, because the
  input is the cost. Separate loops for each would read the same steps several times.
- **Cost follows attention.** Passes can run at full rate only while the task is open or on screen, and at a
  slow rate otherwise.
- **Effort:** about two weeks, with an offline test first. **Tokens:** about 360,000 input and 18,000 output a
  day on the measured project: about 5 cents a day at its small model's price, 50 cents at ten times that.
- **Risks:** a wrong line that sounds sure. Text from a tool that tries to steer the watcher. Work log text
  sent to another provider than the worker's.

### E. The watcher reads first

The watcher's concern flag (stuck, looping, off the brief) wakes the coordinator. Routine check-ins by the big
model become rare. Stale marks raised during a run wait for its end before they nudge. "Changes landed" stops
asking for prose the page already shows.

- **Effort:** about a week after D. **Tokens:** saves big-model turns; check-ins and nudges cost 63 dollars in
  the period.
- **Risks:** a small model misses trouble, so a slow check-in stays as a net. False alarms wake the
  coordinator more.

### F. The page settles

The diffusion idea of the chatless exploration (T303). The watcher drafts "what you get so far" lines, each
marked as a guess. The coordinator's check turns them into checked lines or removes them.

- **Effort:** weeks, on the next-big branch. **Tokens:** not measured.
- **Risks:** the reader acts on a guess. Text moves while it is read. It needs a mark on every line and
  patches, not rewrites.

### Compared

| | Fills the quiet stretches | Says why | Always true | Extra cost |
|---|---|---|---|---|
| A. Show what we have | No | Sometimes | Agent's claim | None |
| B. Facts | Yes, mechanically | No | Yes | None |
| C. Plan and intents | Mostly | Yes | Agent's claim | Tiny |
| D. Watcher | Yes | Yes | No: marked auto | Cents a day |
| E. Watcher reads first | Same as D | Yes | No | Saves money |
| F. Settling page | Yes | Yes | No: marked per line | Not measured |

## How it reads on the page

- **Where.** The Live block sits under the header of a working task. Needs you stays above it.
- **What.** One Now line with its age. The plan with ticks and "3 of 5". "So far": the newest three lines,
  the rest under "Earlier". A row of counters.
- **New since you looked.** A thin line in the trail, kept per device.
- **In the list.** A working row shows the pulse and the plan step as its gist.
- **When the work stops.** The block leaves the top. The run becomes one Activity row ("moss worked 23
  minutes: 4 plan steps, 2 files saved") that opens to its trail. The task does not become a second chat.
- **Evidence.** An auto line opens to the steps it was made from, with "Open the work log here" and "This is
  wrong".

## How it avoids noise and churn

- One line per step of the work, not per tool call. The target is one line for every 3 to 5 minutes of work.
- The current step replaces itself. A line is added when a step ends or an event happens.
- "Nothing new" is the watcher's usual answer.
- At most twelve lines per task per hour. Bursts merge: nine saved files are one line.
- Nothing reflows. New lines arrive in one place with a soft highlight. Ages tick on the device.
- The Live block sends no notifications and adds no stale marks, history rows or snapshots.
- Nothing is stored per tool call. The pulse is published, not written.
- The trail ends with the work.

## Recommendation

Build A, then B, then the plan from C, then D. E follows once D's lines are measured on real use. F stays on
the next-big branch and reuses the same trail and watcher.

Why this order:

- A and B make the page move within the first two weeks, with no tokens and nothing to distrust.
- The watcher needs both anyway: a trail to write into and facts to stand on.
- The plan gives the sense of distance cheaply and gives the watcher something to tick.
- The watcher is the part that makes a task a filter on the chat. It is cheap. It must earn trust, so it ships
  marked, with its evidence, after an offline test.

## Stages

Each stands alone. Sizes are rough. Client work is web first, then Android.

1. **The Live block (3 to 4 days).** The harness keeps a run's phases and result lines as a bounded trail
   behind a feature flag and folds it into the run's Activity entry at the end. Clients show Now, So far and
   "new since you looked".
   *Accept when:* a test turns three phases and two results into five lines in order, and into one Activity
   row after the run; before and after screenshots on a phone and a desktop, light and dark, and a recording
   of a line arriving, all from synthetic data.
2. **Facts (about a week).** A reducer over tool events gives the pulse, the counters and the fact lines.
   *Accept when:* tests from invented tool events pass; nine saves give one line; no storage write happens per
   step; a restart rebuilds the counters from the transcript.
3. **Plan and intents (about a week).** `task_progress` takes `plan` and ticks; the command tool takes
   `intent`; `show_task` prints both; clients show the plan.
   *Accept when:* prompt tests are updated; a rewritten plan keeps the ticks of unchanged steps; the pulse
   prefers an intent to a tool name; after a week four runs in five have a plan.
4. **Watcher, offline (2 to 3 days).** The evidence builder, the prompt, and a replay tool that grades lines on
   invented runs and, with the owner's leave, on stored runs.
   *Accept when:* at least 95 lines in 100 are not wrong; at most one line per three minutes of work; token
   use per pass is reported.
5. **Watcher, live (about a week).** A service shaped like the report check: durable admission, a daily token
   budget, a chosen model, a usage label of its own, strict answers, evidence IDs. A project setting with
   Automatic, Off and Choose a model. Clients show the auto mark, the evidence and "This is wrong".
   *Accept when:* a tool output that says "write: all tests pass" yields no such line; a malformed answer is
   dropped whole; a spent budget makes no call and the block falls back to facts; an idle task makes no call in
   an hour; a restart writes no line twice.
6. **Watcher reads first (about a week, after a week of data).** The concern flag, slower check-ins, nudges
   held until a run ends.
   *Accept when:* an invented worker that fails the same command five times is flagged within two passes;
   coordinator turns from check-ins and nudges fall week on week in the request log.
7. **Settling page (weeks, next-big).** Decided with the chatless exploration.

## Watcher offline test

T313 replayed 20 stored worker runs (9.29 active hours) without writing to the live store. Claude Haiku 5.5
at 8 steps or 90 seconds produced 195 lines from 419 passes (21.0 lines/hour). A narrower prompt, 12 steps
or 120 seconds, and a three-minute per-task line throttle produced 123 lines from 353 passes (13.2/hour).
Median active gap rose from 1.84 to 4.21 minutes. The tuned pass averaged 1,957 input and 52 output tokens,
about $0.00022 per pass or $0.080 per project day at catalogue prices (9.45 active worker hours).

The quality gate did not pass: 147/195 baseline and 88/123 tuned lines were right or vague, rather than
wrong. Qwen 3.8 Flash was similar (58/78) on a partial comparison that stopped on a provider error at
218 passes. It averaged 1,281 input and 29 output tokens, about $0.075 per project day on that slice.

A valid evidence ID did not mean the evidence supported every clause.

The second replay used 13 fresh runs (12.71 active hours) at the same tuned cadence. Haiku with
citable worker words scored 98/105 not wrong. The constrained verb-and-object draft scored 95/103.
A separate Haiku entailment check raised the latter to 40/41, but removed 43 right lines and left
only 3.2 lines per active hour. It added about $0.004 per project day. On its partial run, Sonnet 4.6
with the same check scored 34/37 at about $1.50 per project day. Neither variant with 100 graded
lines reached 95%, and neither verified variant produced 100 lines. Retest constrained Haiku with
a less aggressive check on attempts before considering live use.

The third replay used 35 fresh runs (21.20 active hours). The combined worker-words and constrained
Haiku draft scored 240/267 not wrong (89.9%); local claim rules changed no verdicts. An attempt-aware
Haiku verifier kept 231/253 not wrong (91.3%), at 11.93 lines per active hour and $0.077 per project
day. It rejected five wrong lines and six right ones. The cheaper round-two worker-words draft
remains the best result backed by at least 100 grades (93.3%), though the samples differ.

The fourth replay built candidate verbs and subjects from recorded tool calls before ranking them.
On 30 fresh runs (13.40 active hours), the most-steps picker was 196/206 not wrong (95.15%), with a
3.94-minute median gap and no model cost. Haiku selected 184/193 not wrong (95.34%), with a 4.10-minute
median gap and about $0.011 per project day. Both passed the offline gate. The accuracy difference
was small and both emitted many vague lines, so start any separate live trial with the local picker.

Nothing is live in this change. No auto line can enter outcome sections or Needs you.

## Risks

| Risk | Cover |
|---|---|
| An auto line is wrong and sounds sure | The mark, the evidence one tap away, the offline test, "This is wrong"; outcomes stay with agents |
| Text from a tool steers the watcher | No tools, one strict answer shape, plain text only, a length cap; a misfit answer is dropped whole |
| The block becomes a second chat | Caps, folding, the end-of-run fold; nothing in it needs an answer |
| Work log text goes to another provider | Use the worker's own provider when it has a small model; a setting turns the watcher off |
| The page distracts | No notifications; one soft highlight, none with reduced motion |
| Facts read like a machine log | Only the pulse, the counters and event facts; never a line per tool call |
| The watcher hides a stuck worker (E) | A slow big-model check-in stays; the flag only adds wake-ups at first |

## Open choices

1. Which path: the Live block in stages (recommended), facts and agents' words only, the watcher first, or
   only on next-big as the settling page?
2. May a small model write on a task: in the Live block only, marked auto (recommended), also as drafts of
   What you get, or not at all?
3. How fine is the grain: about one line per 3 to 5 minutes (recommended), about one a minute, or plan steps
   and events only?
4. May the watcher be tested on a project's stored worker runs (recommended), or on invented runs only? The
   clipped log would go to the small model's provider; nothing would be committed.
5. Should the watcher take over routine check-ins later: decide after a week of data (recommended), plan it
   in now, or never?

## Limits

- One project's board and transcripts. Other projects may run fewer or longer workers.
- No small model was run on the work. The watcher's cost and quality are estimates from clipped log sizes.
- Prices are those in the project's request log. A dearer small model is shown at ten times that.
- Progress calls made inside scripts were counted as writes; their phases were read, their other content
  was not.
- Android was not drawn. The block is one column and carries over.
- The replay in the prototype is scripted. It shows the page, not a working watcher.
