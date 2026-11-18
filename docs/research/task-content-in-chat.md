# Task content that ends up only in the chat (T274)

Research only; nothing here is built. It applies to any project (D85).

## Summary

The coordinator is told once that "the detail goes in the task's report". Everything else pulls the other way.
The report is described as short and terse. A task has no place for steps the owner must do, or for an answer
to the owner's question. The tool text offers "answered in chat" as a fine outcome. The one check that could
notice is switched off by exactly that outcome.

One more sentence in the prompt will not fix it. Give the content a named home on the task, let the harness
notice when a reply holds things the task does not, and reword the prompt to match. Four stages, below.

## The problem, with examples

Read from the board of one busy project: 274 tasks, 281 questions and 94 feedback entries over about twelve
days. The main chat transcript was not read (see "Limits").

- **Steps for the owner only in chat (T272).** A five-step procedure in a cloud console, with DNS records, went
  to the chat. The task's Next squeezed it into one sentence. Numbered steps reached the task only after the
  owner complained, and then in the description, which both clients fold away at the bottom as "Brief".
- **Commands only in chat (T270).** Next pointed the owner to the chat for the commands the owner had to run.
- **A procedure that came and went (T150).** Next held a DNS procedure for two hours, written four times in
  different words as the owner asked things. When the task closed, Next was one line and the procedure was gone.
- **Answers to questions asked on the task.** 38 of the 91 addressed feedback entries have a note that points
  at the chat. These are messages the owner sent from the task itself. The note is a summary (median 120
  characters); the answer is in the chat. They are how-to answers, explanations, small analyses and many status
  answers.
- **A decision that leaned on the chat (T57).** Next asked the owner to confirm answers that were only in chat.

What works today, for contrast:

- **Questions.** `ask` texts are long and complete (median 489 characters, up to 1,864, nearly all with
  options). The coordinator writes long text for the owner when a tool asks for it and nothing says "short".
- **Tasks created as an instruction** ("You: …", such as T102, T168, T267) hold their steps in the
  description. Content fails to reach the task when it comes up in the middle of a task.

Next has a median of 140 characters; the longest is 476. Results has a median of 824.

## What the harness does today

- **Prompt** (`coordinatorSection`, `REPORT_RULES` in `packages/server/src/workers.ts`). One sentence: replies
  are "a line or two that name the task; the detail goes in the task's report". The report rules say "short
  report", "keep them short: never append, never repeat", "terse". The opening says the user is waiting, "so
  answer quickly".
- **Board tool** (`packages/server/src/board.ts`). `results` is "short bullets with evidence"; `next` is "what
  comes next and who does it, rewritten whole". No field is for instructions. "Answered in chat" is given as an
  example of a good feedback note in four places: the prompt (twice), the `note` parameter and the tool's own
  error message.
- **Task fields** (`packages/protocol/src/board.ts`). Long text can live in the description, Results, Next, a
  question, a decision, a feedback note, or a file on the task. None has a length limit and all render as
  Markdown, so numbered lists and code blocks already display well. There is no checklist and no notes list.
- **Clients.** The task sheet shows Questions, Report (Next, Now, Results), Timeline, Feedback, Files and the
  rest; the Brief comes last, folded (T275 plans to move it up and open it, which helps tasks created as an
  instruction but gives steps that come up later no home). A chat reply links to a task only through a `T12`
  mention. A reply sends
  a notification; a report write sends none.
- **Check** (`noteChat`, at the end of a turn). If the owner named a task and the reply discusses it without a
  report write, Results/Next are marked "discussed in chat" and a `[reports]` nudge follows. A feedback-state
  write in that turn exempts the task. The check ignores what the reply holds, and the nudge asks only for a
  short rewrite.

## Root causes, ranked

1. **The content has no home.** Steps, commands and answers fit no field. Next is nearest, but it is short by
   rule and rewritten whole each time the work moves on, so steps get squeezed (T272) or lost (T150). A model fills a
   field named for the content; it improvises badly when there is none.
2. **The words push toward chat.** "Short", "terse" and "never repeat" are said many times; "the detail goes
   in the report" once. Told both, the model keeps the report short and puts the detail in the reply.
3. **Chat is the default and the cheapest path.** A direct question invites a direct answer. A task write
   costs a read and a rewrite of a whole section, while the prompt says the owner is waiting.
4. **The check has a gap and a weak remedy.** Marking feedback "answered in chat" silences it. When it fires,
   it leads to another short rewrite.
5. **The task's reply box is one-way.** The owner asks on the task; the answer appears somewhere else.
6. **Waiting on the owner has no state.** A task that needs the owner to act by hand went to Waiting, which
   means "outside the owner's control". Nothing under "Needs you" says "your steps are here".

## Options

Effort: S is about a day, server only. M is a few days across protocol, server and both clients. L is more
than a week.

### Prompt and tool wording

| Option | What changes | Effort | Prevents | Risks |
|---|---|---|---|---|
| A1. Routing rule | A test ("would the owner need this again? then it goes on the task first") and a list: steps and commands → the steps section; a choice → `ask`, options explained in the question; a finding → Results, in full, once; longer than a screen → a file on the task; an answer to a task message → the feedback note. Reply: one line naming the task. | S | Some. A rule exists and is not followed. | Longer reports. |
| A2. Stop offering the chat | Remove "answered in chat" from the four places; the note is the answer itself. | S | Fair, for feedback. | None. |
| A3. Short where it helps | Results and Next stay short; steps and answers are complete, never shortened. | S | Needed by the rest. | None. |

### Tool and schema

| Option | What changes | Effort | Prevents | Risks |
|---|---|---|---|---|
| B1. "Your steps" section | A report section for what the owner must do by hand: numbered Markdown with exact values and copyable commands. Written with `write_report` (`steps`), untouched by Next rewrites, cleared when done, shown at the top of the task. | M | High for procedures and commands, the case the owner raised. | One more section to keep right. |
| B1b. Tickable steps | Each step has a done mark; a tick reaches the coordinator; open steps put the task under "Needs you". | M–L | Follow-through, not prevention. | More client state. |
| B2. Answers kept on the task | The feedback note holds the full answer and shows under the owner's message as a reply. No new field: the note is Markdown without a limit already. | S–M | High for questions asked on a task. | A long Feedback section; fold long answers. |
| B3. Notes list | An append-only list of coordinator entries on the task. | M | Medium to high. | The task becomes a second chat; the design chose "rewrite, never append". |
| B4. Replies through a tool | Turns end with `reply(task, summary, detail)`; the detail is stored on the task. | L | Highest on paper. | Changes every turn; models still write plain text; wrong task; chat-shaped text on tasks. |

### Harness checks

| Option | What changes | Effort | Prevents | Risks |
|---|---|---|---|---|
| C1. Warn on pointers to the chat | When a note or report text says the content is "in chat", the tool saves it and answers: "This points at the chat. The owner reads the task: write it here." | S | Good for the measured cases; tool answers steer well. | False alarms where the product itself has a chat, so a warning, not a refusal. |
| C2. "Only in chat" check and nudge | At the end of a turn the owner started, compare the reply with the turn's board writes. Flag: a numbered list of three or more items with no such list on the task; a code block not on the task word for word; a long reply (about 800 characters) beside board writes under a third of that. Mark the task and nudge once through the existing `[reports]` path, naming what is missing. A feedback write no longer exempts the task. | M | High, as a net: the task gets the content one turn later. | An extra coordinator turn per catch. False alarms on real conversation. Must never fire on its own nudge. |
| C3. The harness copies the reply | Same detection; the harness stores the reply on the task itself, with no model turn. | M | High, no tokens. | Unsorted chat text on the task; wrong task when a reply covers two. |
| C4. Small-model check | The hourly report check also judges the reply. | M | Medium. | Tokens; up to an hour late. |

Holding a reply back until the task is written is not proposed: replies stream, and the owner is waiting.

### Clients

| Option | What changes | Effort | Prevents | Risks |
|---|---|---|---|---|
| D1. Task card under a reply | A reply that names a task shows a small card: state and the first lines of Your steps or Next. | S–M | Little alone; it makes one-line replies enough and a missing detail obvious. | Noise; one card per reply. |
| D2. "Keep on task" on a reply | One tap asks the coordinator to file that reply on its task. | S–M | Nothing; it is the repair, one tap instead of a complaint. | None. |

## Recommendation: four stages

Fix the words, give the content a home, add the net, then polish. Each stage stands alone and suits a normal
worker model.

**Stage 1. Words and warnings (S, server only).** A1, A2, A3, C1. Until stage 2, steps go in Next as a full
numbered list that stays until the owner has done them.
*Accept when:* "answered in chat" is gone from prompts, tool descriptions and errors; the prompts say where
each kind of content goes; prompt tests are updated; a test shows the warning for a note and a report text that
point at the chat, and none for ordinary text that mentions a chat.

**Stage 2. "Your steps" (M).** B1: protocol field, `write_report`, `show_task`, snapshots, web and Android,
behind a feature flag. The stage-1 rule then names the new section. B1b follows if wanted.
*Accept when:* a test writes steps, rewrites Next, and the steps are unchanged; an empty string clears them;
both clients show a numbered list with a code block at the top of the task (screenshots, synthetic data); a
backend without the flag shows the old sheet.

**Stage 3. The "only in chat" check (M, server only).** C2, in the existing end-of-turn hook and nudge queue.
It keeps a daily count of flagged and clean turns (numbers only). A project setting turns the nudge off.
*Accept when:* synthetic transcripts cover a five-step reply with a one-line Next (flagged; one nudge naming
the task and "5 steps"); the same reply with the steps on the task (clean); a command missing from the task
(flagged); a long reply with an `ask` of similar size (clean); the turn that answers the nudge and a
harness-only turn (never flagged); a restart (one nudge, not two).

**Stage 4. Where the owner looks (S–M, clients).** B2's display, D1 and D2.
*Accept when:* before and after screenshots on web and Android show an answered feedback entry as a question
with its answer; a reply naming a task shows its card; "Keep on task" files the reply in a test backend.

Left out: B3 and B4 (a second chat, or a change to every turn) and C4 (late, costs tokens). C3 stays in
reserve, for when the stage-3 counts show nudges being ignored.

Signs that it worked, read from the board: notes pointing at the chat fall from 38 in 91 to near none; Next
stops pointing at the chat; tasks that wait on the owner carry steps; flagged turns fall week on week.

## What other products do

From general knowledge, not checked for this note. Issue trackers keep the thread on the issue, and their chat
integrations copy a chat thread into it (B2, C3). Agent tools with a plan step let the model leave planning
only through a tool that carries the plan, so it always lands in one place (B1, B4). Issue bodies with
tickable task lists are B1b. "Turn this message into an issue" buttons are D2.

## Limits

- The main chat transcript was not read, so the share of turns with detail only in chat is unknown. Stage 3
  measures it.
- "Options explained in chat before an `ask`" and "findings only in chat" leave little trace on the board.
  The routing rule and the check cover them; no numbers back them.
- No model behaviour was tested. The acceptances test the harness; the effect shows in the counts.

## Questions for the owner

1. Is "Your steps" the right name, and should a task with open steps show under "Needs you", not Waiting?
2. Tickable steps (B1b) now, or plain Markdown first?
3. Is an extra coordinator turn per catch acceptable (C2), or should the harness copy the reply itself (C3)?
4. For short status answers, is the answer in the feedback note enough, or must each also refresh the report?
5. May the chat repeat what is on the task? The proposal checks the task, not the length of the reply.
6. May a worker read the main chat transcript once, for a baseline before stage 1 ships?
