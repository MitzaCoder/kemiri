# Kemiri without the chat (T303)

An exploration for the next big version; nothing here is built. It applies to any project. The prototypes are
in `chatless-tasks-prototype.html` beside this file (one HTML file, synthetic data, no build step, no network).

## The idea

The app is a type box and a list of tasks. The owner says what they want. Work happens in the background.
Whatever needs the owner rises to the top. Outputs differ wildly; the process stays the same. The question
behind it: is the chat transcript needed at all, or are tasks with rich content enough?

## The short answer

- Not as the place to read. Tasks already do that better ("Tasks as the place to read" in `DESIGN.md`).
- Not as the place to talk. A type box does that.
- Yes as a stored log, behind each task's record, for the rare day the owner must see what an agent did.
- Yes as a short talk inside one task, when the owner wants to think out loud. It folds into what was settled.

## The loop

Every direction shares it. The first prototype on the page shows it as one screen.

1. **You say.** A request, a question or feedback, in one type box.
2. **It lands.** A receipt above the type box says where the message went: a new task, two tasks, or a task
   that exists. One tap undoes it. Inside an open task there is no routing: the words go to that task.
3. **It fills in.** The task has a first guess within a second, then keeps settling (see Diffusion).
4. **It rises.** When it needs the owner it moves to the top with one of five asks: read (an answer), decide
   (a question), check (an output with evidence), do (steps only the owner can do), rescue (a failure).
5. **You respond.** One tap, or more words in the same type box. The loop runs again.

A read answer closes itself: reading it was the review. Only the owner closes a task that changes something.

## Five directions

They can be combined. Each has a clickable prototype.

### 1. Diffusion: content that settles

A task has content as fast as a chat starts to answer. It is then refined, pass after pass, until it is
short, checked and final.

- **The first draft.** A fast, cheap model writes it from the owner's words, the board and the project memory,
  with no tools. It says what it understood, gives a first guess and lists what it will check. For a change to
  code, the first pass is only the understanding and the plan; it never guesses a result.
- **What drives a pass.** New evidence (a file read, a check, a worker's report). A stronger model that
  rewrites the fast one's draft. A second agent that checks each claim. Quiet time, which triggers one pass
  that cuts the text to its shortest form. The owner: feedback, or opening the task. No cause, no pass, and
  every pass names its cause.
- **Settling or final.** Every line is marked as a guess or as checked. The task shows a meter and the word
  "settling" or "settled". Unsettled content never sits under Needs you: settling is what makes a task rise.
  Lines that changed since the owner last looked are marked. A checked line that turns out wrong rises as a
  correction; it never changes silently.
- **Feedback in the middle.** The note becomes a pin that every later pass obeys. The work is steered, not
  restarted: checked lines the note does not touch stay. "Good enough" stops the passes and the spending, and
  the guesses stay marked. "Keep this" locks a line.
- **Costs.** The first pass is cheap. The cost is in rewrites by strong models, so a pass must patch the lines
  it touches, not rewrite the page. A task gets a pass budget, and passes stop early when one changes almost
  nothing. Nothing is measured yet; a first build must count tokens for each pass.
- **Risks.** The owner acts on a wrong guess. Text moves while it is read. The model believes its own guess,
  so later passes must get the evidence first and the guess labelled as unchecked. Polishing never ends
  without the budget. Code cannot diffuse: the page about a change settles, the change is still built in steps.

In the example the text grows from 42 to 69 words and ends at 30: content first gathers, then is cut.

Today's parts that it builds on: the report rewritten in place, checks as data, the freshness mark on a stale
report. New: the instant first pass, the mark on each line, and the rule that settling makes a task rise.

### 2. Living page: the reply is a change

The agent never answers feedback with a message. A note is pinned to a part of the output. The next version
is the answer, and the note shows where it was worked in. History is versions with marked changes, not
scroll. It breaks for outputs with nothing to point at, and for a note that needs an answer, not a change.
The review comments on HTML artifacts that exist today are the start of it.

### 3. Promise first: assumptions, not questions

Before work starts the task shows what the owner will get, a "done when" list, what the agent assumes, and
how free it is (ask first, show when done, just do it). Work runs on the assumptions without waiting.
Review checks each promised line against its evidence. A corrected assumption redoes only what depends on it.
It breaks when nobody reads the assumptions, and it is too heavy for a small request.

### 4. Clear the top: one thing at a time

The list is the map; the app is the top card. The owner answers, checks or reads one thing, and the next one
slides in. "Nothing needs you" is a real end. It fits a phone. It breaks if the order is wrong, and for
reviews too big for a card.

### 5. Talk, then fold

A task can open a short talk for fast back and forth. When the owner ends it, only what was settled and what
is still open stay on the task; the turns go to the record. It is a chat, on purpose: one subject and an end.
If every task grows one, nothing changed.

## Any output, the same five moves

A kind of output (answer, decision, page, change, comparison, proof, numbers, plan, steps, watch) answers
five questions. What does it show on the list? What does checking it mean? What can a note point at? What is
shown between versions? How is it accepted? A new kind is then a small contract, not a new screen. The frame
never changes: state, what needs the owner, the output, the record.

## Without a transcript

| The chat gives today | Without it |
|---|---|
| A reply within a second | The first guess on the task |
| A sign that work is alive | The Now line and the settling meter |
| How it got there | "Why" lines: decisions and assumptions |
| Proof that it ran the tests | Checks and files recorded by the harness |
| Catching a wrong turn early | Assumptions before work; drafts visible while they settle |
| "As I said before" | Notes on the task; project memory across tasks |
| Stopping or steering | The type box inside the task; Stop on the Now line |
| Quick back and forth | A talk inside one task, folded |
| Scrolling back through a day | "While you were away": one generated page |
| Debugging the agent | The full log behind the record, to search or to ask |

The record has three depths: why (written for the owner), what happened (made by the harness from what ran),
and the full log (the old transcript, stored as today).

## Where it breaks

| Loss | Cover | Still open |
|---|---|---|
| Thinking together in fast turns | A talk inside a task | Slower than a chat if most use is talk |
| A message lands on the wrong task | The receipt, with undo | A wrong landing nobody looked at |
| A wrong direction shows only at review | First guess and assumptions in seconds | The owner must look |
| A clean page is easier to believe | Harness evidence, a second agent, guess marks | A well-written wrong page |
| Everything rises at once | Sort by what unblocks most; "done without you" | Review stays the limit |
| A list full of small questions | Seen is done; answers fold away | Needs good search |
| Content that moves (diffusion) | Change marks; corrections rise | More attention than final text |
| Agents write for a chat (T274) | One agent per task: its reply is the task | Short final text is harder |
| The thread across tasks | Links by the router; project memory | Memory is thinner than a conversation |
| Cost | Cheap early passes, patches, budgets | Not measured |

## Underneath

- **A. Hide the chat.** Today's coordinator stays, unseen, and must put everything on a task. Days of work;
  it can be tried on the live app. Content can still land where nobody reads.
- **B. A router and one agent per task.** A small fast model files each message and writes the first guess.
  Each task has its own agent, started from the task page. A reply lands on its task by construction, and
  there is no long main conversation to compact. The router can be wrong.
- **C. The page is the memory.** Agents keep nothing between runs: each starts from the task page, the
  project memory and the files. Page quality becomes testable. The page must hold everything that matters.

## Recommendation

Build the loop. Let content diffuse. Answer feedback with changes. The promise is what the first diffusion
pass writes, not a gate. Talk stays as a mode inside a task. Clear the top can become the phone's home later.

1. **A week with the chat off**, on today's app: a switch hides the transcript, and each time the owner opens
   it anyway, one tap says why. That list is the real gap.
2. **The loop**, on `next-big`, web only, on today's board, with the hidden coordinator underneath (A).
3. **Diffusion for questions and findings**: the fast first pass, marks on each line, the settling rule.
   Count the tokens of each pass.
4. **The living page**: notes pinned to parts of an output.
5. **One agent per task** (B). Then test C: can a fresh agent go on from a task page alone?

## Open choices

1. What goes into the first real build: the loop with diffusion and the living page, the loop only, or all five?
2. What may the first guess say: a guessed answer for questions and findings and only a plan for changes,
   always a guessed answer, or never an answer?
3. How does unsettled content show: marks on each line with a meter, one word on the task, or hidden?
4. The transcript: a log behind each task's record, one tap away as today, or not shown?
5. Thinking out loud: a talk inside a task, a chat tab beside the list, or no talk?
6. Underneath: hide the coordinator first, one agent per task from the start, or the page as memory?
7. A week with the chat off on the live app before building?
8. One list per project first, or one list for all projects from the start?

## Limits

- No model was run. Speeds, pass counts and costs are design targets, not measurements.
- The prototypes are scripted. They show the interaction, not a working router or agent.
- Android was not drawn. The frames are phone-sized so the same layout can carry over.
- One synthetic project. Long-running work with many workers was not mocked.
