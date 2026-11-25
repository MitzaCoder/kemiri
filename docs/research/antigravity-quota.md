# Antigravity subscription quota sources

Research snapshot: 19 November 2026. The missing gauge meant Kemiri had no reader, not that the plan had no quota.

## Where quota can be read, from lowest to highest account risk

1. **Google's own app, IDE and CLI.** The [plans page](https://antigravity.google/docs/plans/) points to the Settings
   page for baseline quota and describes weekly limits and five-hour refreshes for eligible tiers. The [desktop
   changelog](https://antigravity.google/docs/changelog?tab=hub) calls out the model selector's **View Usage** panel and
   notes that Enterprise and Business accounts do not have per-model quotas. The CLI's [Model quotas pane](https://antigravity.google/docs/cli/commands/usage/)
   opens with `/usage` or `/quota`, refreshes from disk and backend, and shows remaining quota for shared model groups.
   The first-party UIs are the lowest-risk manual option. For Kemiri, the lowest-risk machine reader is the same
   installed Google agent: **`agy --print /usage --output-format json`**. Google's [1.1.11 release notes](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.1.11)
   explicitly say it does not run an agent turn, spend quota or create a conversation. [1.2.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.2.15)
   confirms UTC resets for piped and JSON output. Successful signed-in reports from [Postbox (1.5.10)](https://github.com/HJeon139/postbox/issues/1466)
   and [Agent Guild (1.4.7)](https://github.com/oddessentials/agent-guild/issues/320) show `status: SUCCESS`,
   `num_turns: 0`, `command.name: usage` and `command.data.groups[].buckets[]` with `id`, `window`,
   `remaining_fraction` and `reset_time`. The JSON fields are observed, not a versioned contract. [Google's headless
   guide](https://antigravity.google/docs/cli/headless/) says to run locally answered slash commands separately,
   not in the NDJSON input stream. [BB's agy plugin](https://github.com/ChezRD/bb-agy-usage) uses the official print
   command and does not read tokens. No verified ban was found for just the standalone read-only command. This
   relative risk ranking does not grant Google approval for a third-party consumer integration or delegated workers.
2. **Official ACP.** Also low risk as a read transport if Google adds quota to it. The signed-out pin negotiated ACP 1,
   advertised `loadSession`, session load/resume/list/close/additional directories, prompt image and embedded context,
   and logout. It did not advertise an account quota capability. The only Antigravity capability metadata was
   `agentCapabilities._meta.antigravity` with `tier: true` and `systemPrompt.append: true`. In the worker-equivalent
   layout, `session/new`, `session/list` and a `session/prompt` sent to a synthetic session all returned
   `-32000 Authentication required` without `error.data`. No usage, rate-limit or quota notification was observed.
   Candidate `session/usage`, `session/quota`, `session/rate_limits`, `_antigravity/usage`, `_antigravity/quota`,
   `_antigravity/getQuota` and `_antigravity/getUserStatus` returned `-32601 Method not found`. A [public signed-in
   report](https://github.com/Mai0313/VibeCodingTracker/issues/349) reports `session/new._meta.antigravity.tier` as
   a plan label, not a balance. [Another report](https://github.com/google-antigravity/antigravity-cli/issues/1045)
   observes prompt `usage` token counters in native `agy acp` 1.5.3. They are not quota. A live exhaustion payload
   was not tested. Existing adapter error handling can identify a quota failure but cannot supply remaining share
   and reset times without a reading. Do not send `/usage` as a session prompt on a real account.
3. **On-disk state.** Low account risk for simply listing files, but not a quota feed. In the disposable worker-shaped
   profile the pin wrote `settings.json`, `installation_id`, `jetski_state.pbtxt` and `conversation_summaries.db`
   with SQLite companions. The live managed profile's names show the native `antigravity-oauth-token` file,
   `cache/acp-auth-state.json`, other cache entries, conversation databases, logs, agent artifacts and bundled
   skills. Kemiri also maintains `models.json` separately. No dedicated quota file was identified from names and
   structure. A cache could be stale or differ by release. Cache contents, token contents and real logs were not
   inspected. T3's [history reader](https://github.com/pingdotgg/t3code/blob/bc6062805db775019cf6f13cc543e694ad9e20fc/apps/server/src/provider/Drivers/AntigravityUsage.ts)
   reads conversation DBs for tokens and cost, not remaining quota.
4. **Undocumented local language-server RPC.** More risk and fragility than the official print command, though a
   local read does not itself extract or send a subscription token to Google. [CodexBar's source notes](https://github.com/steipete/CodexBar/blob/1f6da9bec44455288ddee5ef6f3617a803d8eb2a/docs/antigravity.md)
   describe `RetrieveUserQuotaSummary` for the app or older CLI, and `GetUserStatus`/model config fallbacks for
   the IDE, often with only per-model session reset data. [An older `agy` test](https://github.com/steipete/CodexBar/issues/1178)
   found real fractions locally, but CodexBar reports that newer `agy` gates the endpoint with CSRF and falls back
   to the documented print command. Do not discover or bypass private access controls to read limits.
5. **Undocumented Google Cloud Code quota calls with subscription OAuth.** Highest risk. T3's [quota reader at the
   reviewed revision](https://github.com/pingdotgg/t3code/blob/bc6062805db775019cf6f13cc543e694ad9e20fc/apps/server/src/provider/antigravityUsageLimits.ts)
   is separate from its `agy acp` driver: it reads OAuth material, refreshes it and calls Google's internal quota
   summary and model endpoints directly. CodexBar also has a remote OAuth mode with internal endpoint fallbacks.
   Google [confirmed suspensions](https://github.com/google-gemini/gemini-cli/discussions/20632) for third-party
   tools/proxies accessing Antigravity resources and quotas. The [Antigravity terms](https://antigravity.google/terms/)
   allow loss of Antigravity and/or Gemini CLI access. This confirms enforcement against the pattern, not that
   Google specifically banned T3 Code or a named quota monitor. There is a [secondhand CodexBar suspension report](https://x.com/GergelyOrosz/status/2095453567955968398),
   without independent attribution or a confirmed source mode. No verified tool-specific T3 Code ban was found.
   [Forum guidance](https://discuss.ai.google.dev/t/197131/3) about directly human-prompted T3/Zed sessions is narrower
   than approval for OAuth quota calls or unattended consumer delegation. Kemiri does not implement these calls.

## Pinned Linux x64 CLI checks

`agy --version` reported `1.5.12`. Top-level help and subcommand help were inspected for `acp`, `agent`/`agents`,
`changelog`, `help`, `install`, `mcp`, `mic-serve`, `models`, `plugin`/`plugins`, `remote-control` and `update`,
plus MCP, plugin and remote-control leaves. Some plugin leaves treat `--help` as an argument rather than a flag.
Bare `usage`, `quota` and `status` reject the positional argument. `remote-control status` reports daemon status,
not account quota. `models` lists selectable models, requires sign-in and advertises no quota format. Google lists
`/help`, `/model`, `/credits` and `/usage` (alias `/quota`) in its [slash reference](https://antigravity.google/docs/cli/reference/).
Only `/usage` is the grouped subscription meter; AI credits are a separate overage balance. In an isolated signed-out
profile, standalone print requests for `/usage` and `/help` reached authentication and were bounded externally.
There was no signed-in probe of the local account and no request using its credentials.

A filename-only trace of the isolated pin showed print mode reads `~/.gemini/antigravity-cli/antigravity-oauth-token`;
`GEMINI_HOME` did not redirect it to the ACP directory. The backend gives print mode a disposable HOME and an alias
for the managed native app directory, so atomic credential refresh stays with Google's CLI. Neither a token
inspection nor a token transfer into the backend's HTTP client is needed. The fake-agent integration proves the profile routing, a native atomic file replacement through the alias,
the protocol readings and scoped ledger entries.

## Signed-in print-mode check (T483, 25 November 2026)

A disposable copy of the native profile was enough to run the pinned 1.5.12 command without changing the managed
profile or opening its credential in Kemiri. The process exited 0 with `SUCCESS`, `num_turns: 0`, and the existing
`remaining_fraction` and UTC `reset_time` fields. Both model pools returned `1` and a reset exactly one window
in the future for both durations. The native log showed print-mode sign-in completing, the slash command running,
and a background refresh cancelled on exit. That output did not provide a verified balance or actual reset.
Copying the existing cache, forcing ACP file storage, or testing without `--sandbox` did not change the placeholders.

Kemiri distinguishes that result from a measured zero with an actual reset. It skips placeholder buckets and sends
an unavailable reason when no measured bucket remains. It keeps the last trustworthy reading without appending a new
sample. No private endpoint or alternate authentication route is used to fill the missing data.
