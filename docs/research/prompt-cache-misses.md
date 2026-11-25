# Prompt cache misses: mechanisms and fix plan

A study of where conversations re-bill prompt text the provider should have cached, and how to stop it (T480).
Workload measurements stay in private local records, as for `cache-keep-warm.md`. This note keeps the mechanisms, the
code they live in and the plan, so a builder can start without redoing the analysis. Nothing here is built yet.

## How it was studied

The request log (`request-log-store.ts`) has one row per model request with token classes, the miss the protocol's
`CacheMissTracker` found, the idle gap, what woke the agent and the prompt changes (`prompt-fingerprint.ts`). Each miss
was given one cause from those fields and the request before it. Tool and section changes were counted in the
transcripts' `pi.system` entries. Backend restarts came from the service journal.

## Mechanisms found

### 1. One changed tool re-sends every tool (pi-durable)

`planTools` in pi-durable's `harness/prompt.js` keeps the tool order equal to the desired order. A changed declaration
is removed and re-added, and replay appends additions. When that does not give the desired order, it removes every
offered tool and re-adds every desired tool. A changed tool is rarely last, so nearly every change to one tool's text
becomes a full re-send of twenty to forty tools in one `pi.system` entry.

On Anthropic's native mid-conversation tool changes (pi-ai `anthropic-messages.js`, `tool_addition` blocks) that
update reads only the head of the prompt and writes nothing. The next request then writes the whole conversation
again. Text-only section updates, and an update that appends a single tool, keep the cache. The re-sent definitions
also stay in the transcript until the next compaction.

A backend restart with new tool text triggers this for every live conversation. An install that deploys often pays it
often.

### 2. Keep-warm replays a continuation body (Kemiri)

Since pi-ai's Anthropic message threads, most requests go over the wire as a continuation: only the new messages, with
`thread: { type: "continue" }` and without `system` and `tools`. `request-log.ts` captures the HTTP body in
`captureFetch` and hands it to `CoordinatorCacheWarm`. `zeroOutputPayload` (`cache-warm-transport.ts`) strips `thread`
and replays the rest with `max_tokens: 0`. For a continuation that is not a whole request. The provider rejects it and
the stretch stops with "provider request failed". Pings succeed only when the last real request happened to be a
thread create, which carries the full body.

The same captured body feeds the prompt fingerprint, so `wire:messages[0]` and `wire:thread` show as changed on almost
every Anthropic request. The diagnosis of real wire changes is hidden behind that.

A restart that changes the rendered prompt also stops keep-warm (`prefixRevision`). Once updates are small appended
entries, the old prefix stays valid and could stay warm.

### 3. Codex placed `instructions` after the input (pi-ai, fixed)

From GPT-6.2 on, the Codex backend appends the top-level `instructions` field after `input`. Every new turn then
changed the prompt before the system prompt, which was never served from the cache. pi-ai 1.6.0 sends the system
prompt as a leading developer item instead. Nothing is left to fix in Kemiri. It ran unnoticed for days, which is the
case for a cache health signal.

### 4. The skills list flips after each restart (Kemiri)

The built-in `agent-browser` skill is offered once `offerManagedAgentBrowser` has run, and
`WorkerBrowserService.ensureReady()` calls it lazily when a worker first needs a browser. After a restart the skill is
missing from the first prompt and returns later. Each flip re-sends the whole skills section to every live
conversation. The update hits the cache, but the copies stay in the transcript.

### 5. The memory agent re-bills its prompt every round (Kemiri)

`runMemoryAgent` (`memory-agent.ts`) loops with `cacheRetention: "none"`. A run takes several rounds of tool calls,
and each round sends the whole prompt again at the input price.

### Smaller ones

- Compaction summaries (`compaction.ts`, `#narrate`) read the transcript once at the input price with a prompt of their
  own. Reading through the conversation's cached prefix would be cheaper but asks the summary in a different way.
- Provider-side misses with an unchanged prompt exist at a low rate, mostly early in a Codex conversation or on a
  retry. Nothing in Kemiri causes them.
- The one-hour cache for coordinators pays for its dearer writes many times over. The five-minute cache is right for
  workers: an hour would cost more in writes than their idle misses lose.
- Cold starts are cheap. Sharing a cached prefix between workers is not worth building.

## Plan

Each stage is generic and independent of the others.

1. **Tool updates.** In the pi-durable patch, let `planTools` return the minimal change and stop treating order as a
   reason to re-send everything. The same rule must hold on the next turn, or the order difference triggers the
   fallback again. Report it upstream. Check on the first deploy that changes a tool: the update request must read the
   whole conversation from the cache. Replacing an existing tool by one `tool_addition` is not yet observed; if it
   still misses, apply text-only tool changes at the next compaction or cold wake instead.
2. **Keep-warm and fingerprints.** Keep the full parameters pi-ai built (the `onPayload` value, before
   `prepareThreadRequest`) for both the warm snapshot and the wire fingerprint. `refreshAnthropicCache` already passes
   `disableContinuation`. Stop pings once a background coordinator has finished. Let a restored snapshot survive
   appended prompt updates. Check: pings after a mid-turn request show cache reads and no errors.
3. **Stable skills and memory caching.** Resolve the browser tool at backend start, before any prompt is rendered.
   Ask for short retention in the memory agent loop. Check: no `update:skills` after a restart, and cache reads on
   memory rounds two and later.
4. **Cache health.** Flag a model whose mid-turn requests start missing with no prompt change, in Usage → Worth a
   look. Then measure a week again before deciding on a longer keep-warm limit or cached compaction summaries.

## Looked at and not recommended

- Holding prompt changes back until the cache is cold: agents would run on old instructions, and with stage 1 an
  update is cheap.
- Moving the board digest, memory index or skills out of the system prompt: they already arrive as appended updates
  that keep the cache.
- Timing check-ins to the cache lifetime: working keep-warm covers the few that hit a cold cache.
