# Task details that read in one pass (T285)

Research and a proposal; nothing here is built. It applies to any project. A prototype of the proposed page is
in `task-details-rethink-prototype.html` beside this file (plain HTML, synthetic data, no build step).

## Summary

Reading a task today takes word-by-word attention. Two causes work together.

- **The writing.** Report text is a work log: long bullets, commit hashes, test counts, IDs. A question retells
  the task before it asks.
- **The page.** Up to eleven boxes of equal weight, ordered by kind of data. One fact shows in up to five
  places. The action is far from the ask.

The proposal: one page that reads from top to bottom in the order of the owner's questions (what do you need
from me, what came out, what is missing, what happens next). Agents write short sentences for a person. The
page shows the record (commits, checks, history) from data the harness already has, folded at the end.

## What was measured

The board of one busy project: 285 tasks, 283 questions, 102 decisions. Counts only. Today's page was rendered
by the web app from a synthetic task on a throwaway backend.

The writing:

- **A bullet is a paragraph.** The median Results bullet has 23 words; one in ten has more than 51; the longest
  has 125. In 124 of 271 reports the longest bullet has 50 words or more. Facts are chained: 2.3 semicolons and
  2.8 brackets per 100 words.
- **A work log.** Per 100 words of Results: 2 commit hashes and 5 numbers. 107 of 271 reports list test counts
  in a "Checks" bullet. 82 describe the proof files in words, on a page that shows the files.
- **Shorthand.** The prompts and tool texts said "short" or "terse" five times (before T277). Agents dropped
  the small words: "root 1,284 tests, typecheck, web check/test/build".
- **IDs in place of names.** Next has 3.3 IDs per 100 words ("Q2 open", "after Q2", "see T4").
- **Next is three things in one paragraph.** 258 of 268 are a single paragraph mixing the state, what agents
  will do and what the owner must do. 112 tell the owner to close the task, in prose.
- **A question retells the task.** Median 84 words, one in ten over 180. The question itself comes last: 35 of
  276 open with it, and in half of them the first question mark is at the very end. The choices are explained
  in the text (126 have a list there) and named again on chips (median chip: 16 characters).
- **The brief serves two readers.** 227 of 280 descriptions are one paragraph: the request plus file paths for
  workers. "Done when" is a checklist written as one sentence (6.9 semicolons per 100 words).

The page:

- **Up to eleven boxes.** Questions, Blocked, Report, Brief, Timeline, Feedback, Files, Related, Workers,
  Decisions, History. Each has a header band and a chip. A navigation rail is needed to move among them.
- **One fact in up to five places.** A waiting question shows in the status chip, the question card, Next, Now
  and Results. Once answered it shows as an answer, a decision whose reason is "answer to Q…", and timeline rows.
- **Long lines.** About 125 characters on a desktop. A comfortable line has 60 to 75.
- **No order inside the text.** The ask, the outcome and the test counts have one size and weight. Grey
  freshness lines sit under each report section.
- **The action is far from the ask.** The steps are in Next, the close control in the header, the owner's
  message in Feedback, the answer often in the chat (T274).
- **Long questions needed two tools.** "Show more" and the enlarge dialog exist because a question does not fit
  where it is asked.

## The proposed page

See the prototype for the look. In order:

1. **Header.** State ("Needs your answer", "Ready for you to check", "Working", "Done"), title, and one
   sentence that says what the task is for.
2. **Needs you.** The only tinted block. It holds whatever waits for the owner, with its controls:
   - a question: one sentence, up to three lines of context, choices that each say what happens if picked, the
     recommended one marked, free text and "Ask back";
   - a heads-up (today's warning): one or two sentences and "Got it";
   - a check (today's review): numbered steps, then "It works: close the task" and "Something is off…";
   - steps the owner must do by hand (the "Your steps" of T278).
3. **What you get.** A summary of one or two sentences, then one fact per line with a tick. Three proof
   thumbnails from the task's files.
4. **Not done.** What is missing or left out, one per line. A follow-up task shows by title and state.
5. **Next.** What the agents will do, in one or two sentences.
6. **Your notes.** The owner's messages on the task, each with its reply under it, by the reply box. Settled
   ones fold.
7. **The record.** Folded rows: Checks, Changes (commits), Decided, The request (the owner's words, "Done
   when" as a list, notes for agents), Activity (timeline, history, workers).
8. **About this task.** Delivery (built, merged, live), part of, see also, links, files. At the side on a
   desktop, below on a phone. Tasks show by title, not by ID alone.

Gone: the section navigation, the chip on every heading, and freshness lines on a current report (an outdated
report says so in one line).

## The writing rules

For every text on a task:

1. Start with what is different for the reader, not with what you did.
2. One fact per line: one sentence of about 20 words at most. No semicolons.
3. Whole sentences, with their verbs and small words. Short is good; shorthand is not.
4. Leave the record to the page: no commit hashes, change IDs, test counts, file paths or worker names in
   sentences.
5. Name things ("the deploy question"), do not cite them ("Q2"). The page adds the link.
6. Say it once. Do not repeat the status, a question, the files or a decision.
7. The reader's steps are a numbered list, each starting with a verb. What agents will do is one or two
   sentences. Never mix them.
8. Say what is not done as plainly as what is.

For a question:

9. The first sentence is the question, and a choice can answer it.
10. Then only what is needed to choose, in three short lines at most. Do not retell the task.
11. Every choice says what happens if it is picked. Mark the recommended one and say why in a line.

The rules limit a line, never the number of lines: steps and answers stay complete (T274, T277).

The board tool checks the text, saves it, and answers with what to fix, like the warning T277 added for text
that points at the chat: a line over about 30 words, a token that looks like a commit hash, a question whose
first sentence is not a question, choices listed in the text as (A) (B) (C).

## What changes underneath

| Today | Proposed | Filled by |
|---|---|---|
| Description: one paragraph with request and pointers | Goal sentence; the request in the owner's words; notes for agents | Coordinator |
| Done when: one sentence | A list; each line ticked when shown to hold | Coordinator |
| Results: bullets | Summary; lines of what you get; lines of what is not done | Coordinator, workers |
| "Checks" bullet | Checks: name, passed or failed, count | Workers, through their tool |
| "Proof" bullet | Nothing to write: the task's files | The page |
| "Built in commit…", "deployed from…" | Delivery, from the change ledger and deploy feed (T124) | The page |
| Next: one paragraph | Steps for the owner (T278); Next for the agents | Coordinator |
| Question: text and option labels | Question; context; options with label and effect; recommendation | Coordinator |
| Answered question plus a decision that repeats it | One "Decided" line with the question behind it | The page |
| Feedback, often "answered in chat" | Notes with their replies (T280) | Coordinator |
| Timeline, History, Workers, Now | One Activity list | The page |
| Related, refs, time, workers | "About this task" | The page |

A task with no code shows no Delivery and no Changes. The question card is shared, so the "Needs you" list
and notifications get the same shape.

## Stages

Each stands alone. Sizes are rough.

1. **The words (about a day, server only).** The rules in the prompts and tool texts; the tool warnings.
   *Accept when:* prompt tests are updated; a test shows the warnings for a 40-word line and a hash, with the
   text saved; after a week the board shows the median line under 15 words, hashes near none, and the median
   question under 60 words.
2. **The page with today's data (days; web, then Android).** New order, the "Needs you" block with its
   controls, the reading width, the folded record, tasks by title, notes by the reply box. No protocol change:
   Results show as "What you get", Next as "Next". Old tasks keep their text.
   *Accept when:* before and after screenshots on a phone and a desktop, light and dark, from synthetic data;
   a review task can be closed from the block; an open question can be answered from it.
3. **The fields (about a week; protocol, server, both apps).** Goal, summary, not-done lines, steps, checks,
   question options with an effect and a recommendation. Old tasks keep showing their Markdown.
4. **One record (days).** Decided; Activity; Delivery from the ledger.

## Open choices

1. Is this the direction, and do stages 1 and 2 start now?
2. On a desktop: facts at the side, or one column everywhere?
3. Commit hashes and test counts: folded in the record, or one visible line?
4. New fields (stage 3), or free Markdown with rules only?
5. Should T278 and T280 build their app parts inside this page, not on today's sheet?
6. Web first and Android after, per stage, or both together?

## Limits

- One project's board.
- No model was tested against the rules; stage 1 measures that.
- Android was not rendered; it has the same sections in the same order as the web sheet.
- The prototype shows one kind of task.
