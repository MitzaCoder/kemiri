# Making Kemiri’s Settings Intuitive

*First-pass UX analysis of every user-changeable setting in Kemiri (web and Android), written for both product owners and non-technical readers.*

---

## Executive summary

Kemiri is a capable AI work harness that can manage any kind of project—software, research, writing, operations, or personal planning. Right now, however, its settings reflect **how the system is engineered** rather than **what a person is trying to do**.

Three patterns create most of the friction today:

1. **Important things are hidden; technical plumbing sits up front.** Connecting an AI account (the first thing anyone must do) is buried four clicks deep under `Settings → Backends → [computer] → Accounts and API keys`. Meanwhile, Claude-specific billing cache rules (`Prompt cache`) and Git tracking (`Delivery` on Android) sit at the top level of project settings.
2. **Similar settings overlap across six to eight places.** You can pick AI models in the chat box, in `Coordinator`, in `Workers`, in `Scheduled tasks`, in `Report check`, in `Live news lines`, and in `Memory maintenance`. Some help text even contradicts what the app actually does (for example, `Coordinator → Thinking level` says *"The composer can still change it for one conversation"*, even though changing it in the chat box permanently overwrites the project setting).
3. **Scope is mixed inside the same screen, and developer jargon is everywhere.** On a single backend page, one field (`Your name`) changes every project across every device, the next (`Name`) changes only this browser, and the controls require understanding terms like *backends*, *MCP*, *stdio*, *OAuth redirect URL*, *Git ref*, *JSON journal*, *jj workspace*, *daily token budget*, and even *Plain shadcn greys*.

This report catalogs every setting across web and Android, pinpoints the top 10 usability problems with real labels from the app, proposes plain-language rewrites and scope indicators, and compares three ways to reorganize Settings—recommending a **unified Settings view with a clear three-level scope switcher (`This project` · `This computer` · `This device`) and a single `Advanced` area**, paired with an interactive HTML mockup (`settings-ux-mockup.html`).

---

## 1. Complete inventory of settings

Kemiri splits its settings across **four places**:
1. **This device / browser** (stored locally on the phone or in the browser).
2. **A backend / computer** (stored on one Kemiri server and shared by all projects and devices connected to it).
3. **One project** (stored on that project's server and shared by all devices).
4. **Outside Settings** (controls embedded in the chat box, chat header, Usage window, task timelines, and code blocks).

### 1.1 App / This browser or device

| Where it lives | Real label | Help text (actual wording) | Default | Web / Android differences |
|---|---|---|---|---|
| `Settings → Appearance → Theme` | **Theme** (`Jarvis`, `Neutral`) | Web: *"Violet surfaces with a cyan-to-orange gradient."* / *"Plain shadcn greys."*<br>Android: *"Plain greys."* | `Jarvis` | Web leaks the UI library name (`shadcn`). |
| `Settings → Appearance → Theme` | **Light or dark** | Web: *"Follows your device's setting."* (read-only chip: `Dark now` / `Light now`)<br>Android: *"Follows your device's setting unless you choose."* (`Device`, `Light`, `Dark`) | `Device` / system | **Android lets you override**; web is display-only. |
| `Settings → Appearance → Time` | **Time format** (`Automatic`, `24-hour`, `12-hour`) | *"Automatic follows your browser/device locale. Saved in this browser / on this device."* | `Automatic` | Dropdown on web; chips on Android. |
| `Settings → Appearance → Waiting tasks` | **Work day starts at** | *"Return dates use this device’s local time zone. Saved in this browser / on this device."* | `08:00` | Lives under `Appearance` even though it controls task snoozing, not visuals. Footer still says *"The theme is kept in this browser..."* |
| `Settings → Backends` | **Add a backend** (`Name and address`) | *"A bare name like harness-pc expands to the published domain."* (Learn more mentions `wss://<address>/ws`) | Empty list | Android also shows **Published list URL** (`Reload suggestions`), **Pair a device**, and **Connect with a link or QR** (`Scan or paste`) on this same page. |
| `Settings → Backends` | **Suggested backends** (`Add`) | *"Published beside the app. One tap adds one and connects."* | Hidden if none | Same concept on both platforms. |
| `Settings → Backends` | **Connect another device** (`Link or QR code`) | *"Opens this list on a phone or another computer."* (Checkboxes for HTTPS backends) | All HTTPS backends checked | Shares backend URLs only (no login access). Looks almost identical to **Devices → Add a device**. |
| `Settings → Backends → [backend] → This backend` | **Name** | *"Only for you, in this browser / on this device."* | From address/suggestion | Local nickname mixed right beside computer-wide settings. |
| `Settings → Backends → [backend] → Remove` | **Remove this backend** | *"Forgets it in this browser / on this device. Its projects and data stay on the server."* | — | Local-only action on a server page. |
| `Settings → Notifications → This device` | **Notifications on this device** | Web: *"Push is on. See each backend’s state below."* / *"Asks the browser for permission once."*<br>Android: *"With the app open, a notification waits 15 seconds and is dropped if you use the app."* | `Off` | Web also shows per-backend `Enable push` / `Disable push` / `Re-subscribe` / `Sync` + `Send a test`. Android sends via Firebase Cloud Messaging. |
| `Settings → Notifications → Relay notifications` *(Android only, when relay URL configured)* | **Phone notifications through the relay** | *"Encrypted notifications from your backends. Needs an optional relay account."* (+ Google/Email sign-in, `Relay account and phones`, `Delete relay account`) | `Off` | Second notification switch on Android right under the first one. |
| `Settings → Notifications → Events` | **15 individual event switches** + **Reset to defaults** | *On by default (11):* `Coordinator replies`, `Worker failures` [Failure], `Schedule problems` [Failure], `Deploy problems` [Failure], `Login prompts`, `Board questions`, `Background job finished`, `Background job failed` [Failure], `Work finished`, `Low disk space` [Failure], `Tasks ready for review`.<br>*Off by default (4):* `Worker reports`, `Scheduled runs`, `Compaction failures` [Failure], `Maintenance failures` [Failure]. | 11 on, 4 off | Same 15 events on web and Android; synced from this device to every backend. |
| `Settings → Notifications → Quiet hours` | **Be quiet at night** (Web) / **Quiet hours** (Android), **From**, **To**, **Still notify failures** | Web: *"Nothing is pushed in this window."* / *"A failed worker, schedule or deploy comes through anyway."*<br>Android: *"24-hour times, HH:MM."* + manual `Save quiet hours` button. | `Off` (defaults to `22:00`–`07:00`, failures allowed `On`) | Auto-saving time pickers on web; manual text entry (`HH:MM`) + Save button on Android. |
| `Settings → Notifications → Muted projects` | **Muted projects** (`Unmute`) | *"Mute one from the bell in the project's chat header."* | Empty | Can only *unmute* here; cannot mute a project from Notifications settings. |
| `Settings → Archived projects` | **Archived projects** (`Unarchive`) | *"Hidden from the project list; nothing is deleted."* | Empty | Order differs: last on web; second-to-last on Android. |
| `Settings → About` / `About and licences` | Version info & *(Android only)* **Open-source licences** | Android includes *"The pilot has no phone push notifications."* even when Notifications exists. | Read-only | Also hosts backend-wide software update settings (see Section 1.2). |

### 1.2 Backend / Computer level (shared across all projects & devices on one server)

| Where it lives | Real label | Help text (actual wording) | Default | Web / Android differences |
|---|---|---|---|---|
| `Settings → Backends → [backend] → About you` | **Your name** | *"Optional · up to 80 characters. Agents use this name across all projects on this backend, from their next turn. Clear it to stop using a name."* | Empty | Buried inside a specific backend's detail page. |
| `Settings → Backends → [backend] → Devices` | **Devices** (`Rename`, `Sign out`/`Revoke`), **Add a device** (`Confirm new device on this device`, `Create pairing link`), **Pending pairings** | *"Every paired device has full access to this computer, including files, terminals and provider accounts."* | `Confirm new device` = `On` | Embedded inline on web; separate subpage (`Device access → Devices`) on Android. |
| `Settings → Backends → [backend] → Accounts and API keys` | **Ready to use** (`Manage`: OAuth sign-in, Sign out, API key save/remove) & **Add a provider** | *"Signed-in accounts and keys for [backend]. They stay on that backend."*<br>Learn more explains OAuth localhost callback paste workaround. Official agents show ban-risk warning. | None (or from server env vars) | 4 clicks deep on both platforms. Android enables `FLAG_SECURE`. |
| `Settings → Backends → [backend] → MCP servers` | **Servers** (`Add server` via Preset / Remote URL / `Command (stdio)`, `Import JSON`), per-server **Sign in with OAuth** (`Use my own OAuth app` with Redirect URL, Client ID, Client secret), **Connect with a token**, **Refresh tools**, **Disconnect**, **Remove** | *"Remote tools and accounts on [backend]. New servers are off in every project."* | No servers | Requires leaving General settings and visiting each project's MCP page before any agent can use a newly added server. |
| `Settings → Backends → [backend] → MCP servers → [server] → Tools` | Per-tool policy: **Off** \| **Ask** \| **Allow** | *"Hints are supplied by the server, not safety guarantees. Ask requests approval for the exact arguments."* | Backend/server default (`Ask`) | Shows `Read-only hint`, `Write / unknown hint`, or `Destructive hint`. |
| `Settings → Backends → [backend] → Memory maintenance` | **Model**, **Thinking level**, **Nightly at**, **After writes** | *"Tidies the memory notes on this backend, one commit per run."* / *"Pick a model to turn maintenance on."* / *"Backend time ([tz])."* / *"Also run once a scope has this many new writes."* | `Model`: `No model (off)`<br>`Thinking`: `Model default`<br>`Time`: `03:00`<br>`After writes`: `20` | No On/Off toggle—enabled solely by picking a model. |
| `Settings → About` (Web) / `About and licences` (Android) | **Check for Kemiri updates**, **Update now**, **Cancel**, **Restart anyway**, **Dismiss** | *"Checks public GitHub releases about once a day. Does not install or restart anything."* | `On` for installed binary; `Off` for source checkout | Backend-wide setting placed inside App `About` rather than inside the backend page. Compact `Update now` also appears in sidebar footer. |

### 1.3 Project level (shared across all devices for one project)

| Where it lives | Real label | Help text (actual wording) | Default | Web / Android differences |
|---|---|---|---|---|
| `Project → General → Project` | **Name** | *"Shown in the sidebar and the chat's header."* | Folder name | Identical. (Folder & Backend shown read-only.) |
| `Project → General → Archive` | **Archive this project** / **Unarchive** | *"Hide it and pause its schedules. Nothing is deleted."* | Active | Identical. |
| `Project → General → Delivery` *(Web)*<br>`Project → Delivery` *(Android)* | **Integration branch** (`Automatic (main or master)`, `Custom ref`, `Off` + `Git ref`) | *"Commits with a Kemiri-Task: T12 line that land here are shown on their tasks."* | `Automatic` | **Nested in General on web; top-level section on Android.** |
| `Project → General → Delivery` *(Web)*<br>`Project → Delivery` *(Android)* | **Deploy status feed** (`Off`, `File path` + `Journal file`) | *"A JSON journal your deploy scripts write; deploy results then appear on every task they shipped. The harness only reads it."* | `Off` | Same structural split between web and Android. |
| `Project → Coordinator` *(Web)*<br>`Project → Main chat` *(Android)* → `Model` | **Coordinator model** / **Main chat model** | *"Type to search every model this backend offers."* | `None` (required before chatting) | Different section & field names on web vs Android; warning banner on Android still says *"coordinator model"*. Also changed from the chat composer. |
| `Project → Coordinator` / `Main chat` → `Model` | **Thinking level** | *"How much the model reasons before it answers."*<br>Learn more: *"The composer can still change it for one conversation."* *(inaccurate)* | `Model default` | Also changed from the chat composer (both edit the same project setting). |
| `Project → Coordinator` / `Main chat` → `Artifact pages` | **Block artifact pages from sending data** | *"Blocks connections and form submissions. Allowed images, media, CDN files and links can still send requests."* | `Off` | **Combobox on web (`Off (default)` / `On`); Switch on Android.** Unrelated to Coordinator. |
| `Project → Coordinator` / `Main chat` → `Show UI changes` | **Prove UI work with** (`Screenshots and videos`, `Screenshots`, `Off`) | *"Agents show web and app changes before review; backends and terminals are never recorded."* | `Screenshots and videos` | Unrelated to Coordinator model; applies to workers too. |
| `Project → Coordinator` / `Main chat` → `Report check` | **Mode** (`Automatic`, `Off`, `Choose a model`), **Report check model**, **Daily token budget** | *"A small model checks once an hour whether active tasks’ reports missed something, and asks the coordinator to update them."* / *"Resets at midnight UTC."* | `Automatic`, `65,000` tokens/day | Web & Android hints list slightly different fallback model names. |
| `Project → Coordinator` / `Main chat` → `Live news lines` | **Mode** (`Automatic`, `Off`, `Choose a model`), **Live news model**, **Daily token budget** | *"Short updates from the work log, marked auto. They stay in Live and do not change the task report."* / *"Automatic picks from recorded tool steps without sending them to a model."* | `Automatic` (no model), `65,000` tokens/day when model chosen | Buried at bottom of Coordinator page. |
| `Project → Workers → Default worker models` | Ordered list (**Add a model**, Up/Down order, Remove, per-model **Thinking level**) | *"Tried in this order when nothing else names a model."* | Empty list | Silently overridden whenever the chat composer's Worker picker is set to a specific model. |
| `Project → Workers → Check-ins` | **Wake the coordinator while workers run**, **Every** (`N minutes`) | *"A short digest of each worker, so it can steer one that is stuck."* / *"Ten minutes by default; shorter costs more model turns."* | `On`, `10` minutes | **Android has a `Reset check-ins` button; web does not.** |
| `Project → Scheduled tasks` | Per schedule: **Enabled/Paused** switch, **Run now**, **Edit**, **Delete**, **Runs (N)**.<br>Editor: **Title**, **Each run** (`Worker` / `Background job`), **Brief/Prompt**, **Repeat/Run** (interval, daily, weekly, `Cron expression`, `GitHub review requested` + `Repositories`), **Worker/Background job model**, **Thinking level**, **Isolation** (`Shared checkout` / `Own jj workspace`), **On report** (`Reviews it` / `Just record it`), **Enabled**. | Plain summaries of schedule cadence; Learn more explains `gh` polling every 2 minutes. | Enabled `On`, `Worker`, `Shared checkout`, `Reviews it`, `Worker default` model | Identical features on web and Android. |
| `Project → Tickets and pull requests` | **Jira site**, **Ticket prefixes**, **GitHub repositories**, **Fill in automatically** (`Fill in again`) | *"Ticket keys and pull request numbers become links."* / *"From git remotes, commit messages and the machine's Jira sign-in."* | Auto-detected | Relies on CLI logins (`gh`, `acli`) mentioned only in Learn more. |
| `Project → Prompt cache` | **Keep the cache for an hour for** (`Coordinators (default)`, `Coordinators and workers`, `Nobody`), **Keep coordinator cache warm**, **Stop after** (`1 h`, `2 h`, `4 h`, `8 h`) | *"How long Claude keeps a conversation it has already read."* / *"Costs more per write, saves paying for the whole conversation again after a long wait."* / *"Uses cached-input tokens while idle. Claude only."* | `Coordinators`, Keep warm `On`, `8 h` | Top-level section even when the project does not use Claude (rows then grey out with *"Not supported for this provider"*). |
| `Project → MCP` | Per server: **Enable [server]**, plus role switches (**Coordinator**, **Workers**, **Background jobs**) | *"Servers and roles start off. Enabling a server grants only its selected roles access, subject to each tool's backend-wide Off / Ask / Allow policy."* | All `Off` | Two-step setup split across General → Backends and Project → MCP. |
| `Project → Skills` | Search + filters (`All`, `Offered`, `Off`, `New`), per-skill **Offer [skill]** switch, `File details` (`SKILL.md` & hidden paths) | *"What this project's agents know how to do."* / *"Off hides a skill from the agents' list; the file stays readable."* | Undecided (`New`) skills default `On` | Note: protocol supports per-role subsets (shown read-only as `Some roles`), while UI only toggles all roles on/off. |
| `Project → Storage` | **Measure again**, **Clean up finished**, per-workspace **Remove** | *"What this project's workspaces take on disk."* / *"Finished ones are safe to remove; the project's own checkout is never touched."* | Read/action | Appears before MCP/Skills on Android; after them on web. |

### 1.4 Settings living outside the Settings pages

| Where it lives | Control & real label | True scope | Default | Why it surprises people |
|---|---|---|---|---|
| **Chat composer** (Main chat) | **Coordinator model** chip & **Thinking level** chip | **Project-wide** (overwrites `Project → Coordinator` immediately on the backend) | Project's setting | Looks like a per-message or per-chat toggle, and `Coordinator → Learn more` falsely says *"The composer can still change it for one conversation."* |
| **Chat composer** (Main chat) | **Worker picker** chip (`Worker default` or specific model + thinking level) | **Project-wide, synced across all devices** (`workers.defaults.set`) | `Worker default` | Looks temporary, yet persistently overrides `Project → Workers → Default worker models` on every device until manually reset to `Worker default`—while still letting the coordinator pick something else. |
| **Project chat header** | **Bell icon** (`Mute notifications for this project` / `Unmute`) | **This device only** (pushed to backend for this device) | Unmuted | You can mute *only* here, and you see the list of muted projects *only* in `General → Notifications`. |
| **Sidebar → Usage → Value tab** | **Edit price** / **Set price** → **Monthly price (USD)** + `Reset to default` | **Backend-wide** (`subscriptions.price.set`) | Catalog default price | Completely invisible from `Accounts and API keys`, and **only editable when viewing the current month**. |
| **Any code block / tool output** | **Wrap code** icon (`WrapToggle`) | **Device-wide** (every code block in every project on this device) | Off in Markdown code blocks, On in tool output | Looks like a local toggle for one code snippet, but silently flips every code block on the device. |
| **Task sheet → Activity** | **Timeline order** icon (`Newest first` / `Oldest first`) | **Device-wide** (every task in every project) | `Newest first` | No indication that clicking it reverses every task timeline on the device. |
| **Task / Artifact media gallery** | **Separate** / side-by-side compare toggle | **Device-wide** | Compare (off) | Device-wide preference with no mention in Settings. |
| **Tasks panel / Graph / Memory / Sidebar** | `List \| Board \| Graph`, Graph `Live \| All`, Memory `Global \| Project`, Sidebar collapsed | **Device-wide** (or per-project on this device) | `List`, `Project`, expanded | Reasonable as sticky view state, though `Memory` scope (`Global` vs `Project`) is easy to misread as changing what agents remember rather than what you are viewing. |

---

## 2. The 10 biggest usability problems

### 1. The "Coordinator" page is a catch-all drawer for five unrelated features
`Project settings → Coordinator` (renamed `Main chat` on Android) has the subtitle *"The model Main chat runs on."* Yet scrolling past the model picker reveals four completely different systems:
- **Artifact pages** (`Block artifact pages from sending data` — a browser security rule)
- **Show UI changes** (`Prove UI work with` — whether agents capture screenshots/videos)
- **Report check** (an hourly AI audit with a daily token budget)
- **Live news lines** (an automated work-log summarizer with its own model and token budget)

A non-technical owner trying to stop an AI from recording screenshots, control background spending, or tighten page privacy would never guess to look under `Coordinator` or `Main chat`.

### 2. AI models are chosen in eight places—with hidden override rules and contradicting help text
Models and thinking levels are scattered across:
1. Chat composer → Coordinator model & thinking chips
2. Chat composer → Worker model & thinking chip
3. `Project → Coordinator` (`Coordinator model`, `Thinking level`)
4. `Project → Workers` (`Default worker models` ordered fallback list)
5. `Project → Coordinator → Report check`
6. `Project → Coordinator → Live news lines`
7. `Project → Scheduled tasks` editor
8. `General → Backends → [backend] → Memory maintenance`

For **workers**, there is a four-layer precedence stack that nobody can keep in their head: *what the coordinator explicitly asks for* beats *the composer's worker chip* (which quietly syncs across all your devices!) which beats *Project → Workers → Default worker models* (unless it's a scheduled task, which has its own override). And for the **coordinator**, `Learn more` under `Thinking level` claims *"The composer can still change it for one conversation"*, when both controls actually edit the exact same project setting.

### 3. Three scopes (This device, This computer, This project) are mixed together—even on the same page
Kemiri has three real layers of settings, but the interface blurs them constantly:
- On **`Settings → Backends → [backend]`**, `Your name` applies to **every project and every device on that computer**; `Name` right below it applies **only in this browser**; `Memory maintenance` applies to **that computer**; and `Remove this backend` applies **only in this browser**.
- **`Settings → About`** (which looks like an app info page) contains **`Check for Kemiri updates`** and **`Update now`**, which change **each backend computer**, not the web app.
- **`Settings → Appearance`** includes **`Work day starts at`** (a task-snoozing rule), while the footer still says *"The theme is kept in this browser, not on a backend."*
- There are **two completely separate Settings doors** (bottom of the sidebar vs. gear icon in chat), with no way to switch between them once inside and no explanation of which settings live behind which door.

### 4. Heavy developer jargon locks out non-technical people
Even everyday flows rely on engineering vocabulary:
- **Infrastructure & integration terms:** `Backends`, `MCP`, `Command (stdio)`, `Arguments (JSON array)`, `Environment (secret JSON object)`, `OAuth`, `Redirect URL`, `Client ID (write-only)`, `Bearer token`, `Published list URL`.
- **Developer workflow terms:** `Integration branch`, `Git ref (refs/heads/trunk)`, `Deploy status feed (JSON journal)`, `Own jj workspace`, `Cron expression`, `Compaction failures`, `Daily token budget (midnight UTC)`.
- **AI billing plumbing:** `Prompt cache`, `Keep the cache for an hour for`, `Uses cached-input tokens while idle`, `1.25 times vs twice the input price`.
- **Accidental internal terms:** Web's Neutral theme description literally says **`Plain shadcn greys.`** (naming a developer UI toolkit).
- **Unexplained Kemiri concepts:** New users are dropped straight into `Coordinator`, `Workers`, `Background jobs`, `Skills`, and `MCP` without a one-line mental model of how they fit together.

### 5. Essential setup is buried 4 clicks deep while rare technical controls sit at the top level
- **Signing in to an AI provider** (required before Kemiri can answer a single message) is at `Settings → Backends → [select computer] → Accounts and API keys`. Even if a user only has **one** computer—which is the common case—they still have to open `Backends`, tap that one computer, scroll past status/name/address, and tap `Accounts and API keys`.
- **Setting your name** (`Your name`) is buried inside a single backend page instead of an obvious profile spot.
- Meanwhile, **`Prompt cache`** (a Claude-only pricing nuance that 95% of users should never touch) and **`Delivery`** (Git refs and JSON deploy journals, top-level on Android) get prime top-level navigation slots in Project Settings.

### 6. Two different "connect / pair a device" flows look nearly identical
In `Settings → Backends`, users see **`Connect another device`** (`Link or QR code`), which only copies server web addresses to another device without granting login access. Inside a backend (`Settings → Backends → [backend] → Devices`), users see **`Add a device`** (`Create pairing link` + QR code), which grants **full control over that computer**.

On Android, `Settings → Backends` makes this even more confusing by placing **`Pair a device`** (`Sign in with a pairing link`), **`Connect with a link or QR`** (`Scan or paste`), and **`Connect another device`** on the very same screen. A non-technical user setting up their phone has no clear path for *"How do I use Kemiri on my phone?"*

### 7. Notifications mixes 15 granular switches with low-level push plumbing
`Settings → Notifications` asks every user to understand 15 separate notification categories, including internal system events (`Compaction failures`, `Maintenance failures`) and overlapping completion alerts (`Coordinator replies` vs. `Worker reports` vs. `Work finished` vs. `Background job finished` vs. `Tasks ready for review`).

Below or above those 15 switches, users encounter push-protocol internals:
- On web: `On (own subscription)`, `On (shared subscription)`, `Needs re-subscribe`, `This backend's push key changed`, `Sync`, and per-backend `Enable push` / `Disable push` buttons alongside a master `Notifications on this device` switch.
- On Android: **two separate notification master switches** on the same screen (`Notifications on this device` via direct Firebase and `Phone notifications through the relay` via a separate relay account), while `About` still states *"The pilot has no phone push notifications."*

### 8. Web and Android disagree on names, layout, and controls
Anyone who uses Kemiri on both a computer browser and an Android phone hits jarring mismatches:
- `Coordinator` (web) vs. `Main chat` (Android).
- `Delivery` hidden inside `General` (web) vs. its own top-level section (Android).
- `Storage`, `MCP`, `Skills`, `Archived`, and `About` appear in different orders.
- `Light or dark` is changeable on Android, but read-only on web.
- `Block artifact pages from sending data` is a dropdown (`Off (default)` / `On`) on web, but a toggle switch on Android.
- `Reset check-ins` exists on Android, not web.
- `Quiet hours` uses auto-saving time pickers on web, but manual `HH:MM` text fields with a `Save quiet hours` button on Android.
- Android notification errors still call the app **`Harness`** instead of `Kemiri`.

### 9. Connected tasks are split across disconnected screens
- **Adding an external tool (MCP)** is a two-part scavenger hunt: you add the server, sign in, and configure tool policies (`Off / Ask / Allow`) four levels deep in `General → Backends → [backend] → MCP servers`, then have to exit General settings, navigate into a project, open `Project settings → MCP`, and switch on the server and its agent roles (`Coordinator`, `Workers`, `Background jobs`). Nothing links the last step of adding a server to enabling it in a project.
- **Subscription prices** can only be edited inside `Usage → Value`, and only when viewing the current month—nowhere near `Accounts and API keys`, where you actually manage those subscriptions.
- **Project muting** can only be turned *on* from the chat header bell and only reviewed/managed from `General → Notifications`.

### 10. Missing plain-English explanations of real-world impact (and odd controls)
- **Memory maintenance has no On/Off switch.** Users must know that picking a model turns it on, and picking `No model (off)` inside a searchable model list turns it off.
- **Daily token budget (`65,000`)** gives a non-technical user zero intuition for cost or volume (roughly a few cents a day or a few dozen checks—not stated anywhere).
- **`Work day starts at` (`08:00`)** says *"Return dates use this device's local time zone"* without explaining what a return date is (*"When you snooze a task until tomorrow or a date, it returns at this time"*).
- **Hidden device-wide side effects:** Clicking `Wrap code` on a single code block or `Newest first` on a single task quietly changes every code block or every task timeline across the whole device, with no visibility in Settings.

---

## 3. Proposed improvements

### 3.1 Plain-language renaming & one-line explanations (Before → After)

Every setting should pass a simple test: **can a non-technical person predict what will happen when they flip it, from the label and one short sentence alone?**

| Current label & wording | Problem | Proposed plain-language label & one-line explanation |
|---|---|---|
| **Backends** (*"The servers this browser talks to"*) | "Backend" is developer jargon. | **Connected computers** — *"The computers running Kemiri for your projects."* (Keep *"server"* in technical `Learn more` if needed.) |
| **Coordinator** (Web) / **Main chat** (Android) | Inconsistent across platforms; "Coordinator" sounds technical. | **Main assistant** — *"The AI you chat with directly and that organizes work."* (Use the same name on web and Android.) |
| **Workers** (*"Default worker models"*) | Doesn't explain how workers differ from the main chat or how overrides work. | **Helper agents** *(or **Workers** with plain subtitle)* — *"Background assistants that carry out tasks in parallel."* |
| **Accounts and API keys** *(buried 4 clicks deep)* | Hidden inside a backend; mixes two terms. | **AI accounts** *(promoted to top level)* — *"Connect your AI subscriptions or API keys so assistants can run."* |
| **MCP servers** (backend) + **MCP** (project) | Acronym meaningless to non-technical users; split in two places. | **Connected apps** *(subtitle: "via MCP")* — *"External tools like Notion, Jira, GitHub, or docs that assistants can use."* |
| **MCP tool policy: Off / Ask / Allow** + `Write / unknown hint` | "Policy" and "hint" sound like server internals. | **Blocked / Ask me first / Always allow** — with clear badges: `Reads info`, `Can make changes`, `Can delete or overwrite`. |
| **Memory maintenance** (*"Tidies the memory notes on this backend, one commit per run"*) | Mentions "commit"; no On/Off switch; "After writes" is unclear. | **Automatic memory cleanup** — *"Periodically merges duplicate notes and archives old ones."* With a real **On/Off switch**, *"Run nightly at"*, and *"Also run after N new notes"*. |
| **Prompt cache** (*"Keep the cache for an hour for"* / *"Keep coordinator cache warm"*) | Pure API billing jargon; sits at top level even for non-Claude projects. | Move to **Advanced → Claude cost saving** — *"Pays slightly more upfront so long pauses don't re-read the whole chat (Claude models only)."* |
| **Report check** (*"Daily token budget: 65,000, resets midnight UTC"*) | Sounds like a technical log audit; tokens aren't intuitive. | Move to **Advanced → Task summaries → Auto-check task reports** — *"Checks active tasks hourly and reminds the assistant to update stale summaries."* Replace raw token input with simple presets (`Low`, `Standard`, `High`, `Custom…`) with an approximate cost/runs note. |
| **Live news lines** (*"Short updates from the work log, marked auto"*) | Unclear what "news lines" or "work log" are. | Move to **Advanced → Task summaries → Live progress notes** — *"Shows short one-line status updates while work is running."* |
| **Prove UI work with** *(under Coordinator)* | Buried under Coordinator; "UI work" is dev shorthand. | Move to **Advanced → Visual checks** (or **Project → Review**) — **Visual proof of screen changes** — *"Ask assistants to attach before/after screenshots or a short video when they change a webpage or app."* |
| **Block artifact pages from sending data** *(under Coordinator; dropdown on web, switch on Android)* | Buried under Coordinator; inconsistent control. | Move to **Advanced → Privacy & safety** — **Block web requests from preview pages** (Switch on both platforms) — *"Stops generated HTML reports and mockups from sending data over the network."* |
| **Delivery → Integration branch / Deploy status feed** | Pure software-engineering terms; top-level on Android. | Move to **Advanced → Software delivery (optional)** — *"Track finished code commits and deploy logs on your tasks. Safe to ignore for non-coding projects."* |
| **Work day starts at** *(under Appearance)* | Wrong section; doesn't explain "return dates". | Move to **This device → General / Look & feel** (under **Time & schedule**) — **Snoozed tasks return at** — *"When you pause a task until tomorrow or a future date, it comes back at this local time."* |
| **Neutral: "Plain shadcn greys."** | Leaks an internal CSS library name. | **Neutral** — *"Clean, distraction-free greys."* |
| **Events** *(15 notification switches)* | Too many granular toggles; overlapping items; jargon (`Compaction failures`). | **What to notify me about** — 3 plain presets (**Important updates** [default], **Urgent & questions only**, **Everything**) + collapsible **Choose individual alerts** grouped into *Needs your input*, *Work finished*, and *Problems*. |
| **Connect another device** vs **Devices → Add a device** | Two lookalike QR flows with completely different security effects. | Merge into one clear **Add another device** flow that explains the difference upfront—defaulting to **Pair a phone or browser** (grants access with code confirmation), with *"Copy server address only (no sign-in)"* tucked behind a secondary link. |

### 3.2 What goes first, what moves to "Advanced", and what to merge or remove

#### Put first (visible immediately, 1–2 taps away)
1. **AI accounts** (subscriptions & API keys — plus monthly plan price right beside each subscription, synced with Usage!).
2. **Your name** (what assistants call you).
3. **Main assistant & Helper defaults** (one clear page per project showing *both* Main assistant and Workers, with a visible banner whenever the chat composer has an active worker override and a one-click `Reset to project default`).
4. **Look & feel** (Theme, Light/Dark on *both* web & Android, Clock format, Snoozed-task return time).
5. **Notifications** (Master toggle, 3 simple presets, Quiet hours, Muted projects — including an inline mute toggle right inside Project Overview).
6. **Connected apps & Skills** (what tools and guides this project can use).
7. **Routines** (Scheduled tasks).

#### Tuck under "Advanced" (collapsed or in a dedicated `Advanced` tab, still fully accessible)
- **Project Advanced:**
  - *Visual proof of screen changes* (`uiProof`)
  - *Automatic task summaries* (`Report check` & `Live news lines` with model/budget overrides)
  - *Preview page privacy* (`Block artifact pages from sending data`)
  - *Tickets & pull requests* (Jira & GitHub auto-linking — or show under `Tools & integrations` for coding projects)
  - *Software delivery tracking* (`Integration branch` & `Deploy status feed`)
  - *Claude cost saving* (`Prompt cache` — and auto-hide or clearly mark as inactive when the project isn't using a Claude model)
  - *Workspace storage cleanup* (`Storage` — keep deep-linkable from the low-disk warning banner!)
- **Computer Advanced:**
  - *Local nickname for this computer*, *Server address*, *Published backend discovery URL* (Android), *Forget computer from this device*
  - *MCP command (stdio) / Import JSON / Custom OAuth app (Client ID & secret)* inside the "Add app" dialog behind an *Advanced / Custom setup* toggle
- **Device Advanced (inside Notifications):**
  - *Delivery status & diagnostics* (per-computer push registration, own/shared subscription status, `Send a test`, `Re-subscribe`, Android push relay details)
  - *Individual event toggles* (all 15 switches behind `Customize alerts`)

#### Merge, simplify, or remove
1. **Merge `Project → Coordinator` + `Project → Workers` → `AI & helpers`:** Seeing the Main assistant and Helper agents on the same page makes the relationship obvious and cuts navigation bloat.
2. **Eliminate the hidden composer-vs-settings contradiction:**
   - For **Main assistant**, make the composer chip clearly say *"Changes this project's main assistant"* (or show a subtle badge), and fix the inaccurate `Learn more` text in settings.
   - For **Workers**, either make the composer's worker chip visibly show when it is overriding Project defaults (with a 1-click **"Clear override"** button both in the composer and in `Project → AI & helpers`), or unify it so picking a worker model in the composer moves that model to #1 in the project's list.
3. **Merge `Connect another device` and `Devices → Add a device`** into a single **Pair another device** flow (keep URL-only sharing as a secondary option for advanced multi-server users).
4. **Move `Check for Kemiri updates` & `Update now`** out of `About` and onto the computer's own page (keeping a read-only version summary and Android open-source licences in `About`).
5. **Remove `Plain shadcn greys`** and stale **`Harness`** / **`The pilot has no phone push notifications`** wording.
6. **Collapse the 15 notification switches** behind presets by default, and consider merging internal failure kinds (`Compaction failures` + `Maintenance failures` → `System & background errors` in the simple view).
7. **Unify Web and Android 1:1:** Same section names, same section order, Light/Dark override on Web too, Switch for `Block artifact pages` on Web, auto-saving time pickers for Quiet hours on Android, and `Reset check-ins` parity.

### 3.3 How to show which scope a setting affects

Confusion over scope (*"Does this change just my phone, just this project, or everything?"*) is the root of half the trust issues in settings. Four lightweight visual habits eliminate it:

1. **Name scopes in human words, never engineering words:**
   - **This project** (*"Applies to Bakery Launch on every device"*)
   - **This computer** (*"Applies to all projects on Work Laptop"*)
   - **This browser / This phone** (*"Only changes how Kemiri looks and alerts you here"*)
2. **Keep every page single-scope.** Never mix a browser-local setting (like `Local nickname` or `Remove from this browser`) inside the same card as a computer-wide setting (`Your name`, `AI accounts`). If an exception is truly needed (like a quick *"Mute this project on this phone"* toggle on Project Overview), stamp it with an explicit muted pill: **`This device only`**.
3. **Show a persistent scope strip at the top of every Settings view**, naming the exact target (e.g., `Project: Bakery Launch (on Work Laptop)` · `Shared across your devices`).
4. **Collapse the "Computers" list when there is only one computer.** Most non-technical owners connect one computer (their laptop, desktop, or home server). Don't make them click `Backends → Work Laptop → Accounts` every time—open directly onto `Work Laptop` with a small switcher (`Work Laptop ▾` / `+ Add another computer`) in the header!

---

## 4. Three alternative structures (and trade-offs)

### Option A: Unified Settings with Top Scope Switcher + Progressive "Advanced" *(Recommended)*

One unified Settings screen reachable from both the sidebar gear and any project's gear icon (opening from a project simply pre-selects the `This project` tab). A segmented scope bar at the top switches cleanly between **This project**, **This computer** *(or a computer picker when 2+ exist)*, and **This device**.

```
Settings  [ This project: Bakery Launch ▾ ]  [ Work Laptop ▾ ]  [ This device ]
          ─────────────────────────────────────────────────────────────────────
          Scope banner: "Changes here apply to Bakery Launch on all your devices."

This project (5 items)          Work Laptop (5 items)           This device (3 items)
├─ Overview                     ├─ AI accounts  ★               ├─ Look & feel
├─ AI & helpers                 ├─ Profile & memory             ├─ Notifications
├─ Routines                     ├─ Connected apps (MCP)         └─ Archived & About
├─ Tools & skills               ├─ Paired devices & updates
└─ Advanced  ▸                  └─ Advanced  ▸
```

- **Strengths:**
  - Makes scope unmistakable at a glance—users never wonder *"what will this affect?"*
  - Brings **AI accounts** from 4 clicks deep to 1 click (when using 1 computer) or 2 clicks.
  - Eliminates the confusing wall between "Sidebar Settings" and "Project Settings"—you can jump from a project's `Connected apps` straight to `Work Laptop → Connected apps` in one tap without losing your place.
  - Keeps top-level navigation to 3–5 clean, plain-English items per scope while keeping every existing power-user knob intact inside `Advanced`.
  - Works cleanly on both desktop web (left rail + content) and Android phones (top scope pills + short section list).
- **Trade-offs:**
  - Bigger UI refactor than tweaking labels alone (though existing deep-link URLs like `/settings/notifications` and `.../settings/storage` can map cleanly to the new layout).
  - Users still pick a scope tab first—if someone isn't sure whether "AI accounts" belongs to a project or a computer, a small search box or smart cross-links (*"Need to add a provider? Open AI accounts →"*) fills the gap.

### Option B: Goal-Based Flat Settings ("By What You Want to Do") with Scope Badges

Drop the General vs. Project split entirely. Present **one flat list of 7 goal-based categories**, similar to Notion or Linear, and stamp every section/card with a clear scope badge (`This device`, `Work Laptop`, `Bakery Launch`):

```
Settings  [ Search settings… ]
├─ You & appearance          (Your name · Theme · Light/Dark · Clock · Snooze time)
├─ AI accounts & models      (Subscriptions & prices · Main assistant · Helper defaults)
├─ Connected apps & skills   (Install apps + enable for Bakery Launch in one view · Skills)
├─ Notifications             (On/Off · Presets · Quiet hours · Mute Bakery Launch)
├─ Routines & automation     (Scheduled tasks · Check-ins · Memory cleanup · Auto summaries)
├─ Computers & devices       (Connected computers · Pair a phone · Updates · Storage)
└─ Developer & advanced      (Tickets & PRs · Delivery tracking · Claude cache · Privacy · UI proof)
```

- **Strengths:**
  - Best "zero mental model required" findability for newcomers: if you want anything related to AI, open `AI accounts & models`; if you want Notion or Jira to work, open `Connected apps & skills` and both install *and* enable it for your project on one screen!
  - Completely eliminates the split-brain MCP workflow and puts subscription monthly prices directly beside AI accounts.
- **Trade-offs:**
  - **Scope mixing returns inside pages**—on `You & appearance`, `Your name` is server-wide while `Theme` is device-local, so users have to read scope badges carefully.
  - Gets awkward for power users with **multiple computers and many projects** (requires inline computer/project dropdowns on several pages).
  - Harder to preserve clean URL structure when no project is currently open.

### Option C: Minimal Incremental Cleanup (Keep Current Two-Tree Split)

Keep the existing two separate routes (`/settings` for General and `/b/.../settings` for Project), and make targeted cleanup edits without changing the shell architecture:

- **General settings (6 items):** `AI accounts` *(new top-level shortcut for single-backend users)*, `Appearance & time`, `Notifications` *(with presets)*, `Computers & devices` *(merged pair flow + updates)*, `Archived projects`, `About`.
- **Project settings (6 items):** `General`, `AI & helpers` *(merged Coordinator + Workers)*, `Routines`, `Connected apps & skills` *(merged MCP + Skills)*, `Advanced` *(Delivery, Tickets, Prompt cache, Report check, Live news, UI proof, Artifact privacy, Storage)*.
- Fix all jargon, web/Android mismatches, and the composer help-text contradiction.

- **Strengths:**
  - Lowest engineering effort and lowest risk; zero routing redesign; existing users keep their exact habits.
  - Solves roughly 70% of the pain (jargon, dumping-ground Coordinator page, buried AI accounts, notification wall, web/Android parity).
- **Trade-offs:**
  - Keeps two disconnected Settings doors (`Settings` in the sidebar vs. `Project settings` in the chat header).
  - Still forces users to leave Project Settings and dig into General Settings to add an MCP server or AI account.
  - Multi-backend users still face nested drill-downs for `Your name` and `Accounts`.

---

## 5. Recommendation & rollout plan

**Recommend Option A (Unified Settings with Scope Switcher + Single `Advanced` Section)**, paired with a lightweight **Settings search** bar and a **two-phase rollout**:

1. **Phase 1 — Quick wins (can ship immediately, zero routing risk):**
   - Plain-language rename pass (including removing `shadcn`, `Harness`, and inaccurate composer/pilot copy).
   - Split the 4 unrelated cards out of `Coordinator` into a project `Advanced` group.
   - Add a real On/Off switch to `Memory maintenance` and add `Light / Dark / Device` to Web Appearance.
   - Unify Web and Android section names, ordering, and controls (`Delivery`, `Block artifact pages`, `Quiet hours`, `Reset check-ins`).
   - Add simple Notification presets (`Important updates`, `Urgent & questions`, `Everything`) with the 15 individual switches collapsed by default.
   - Surface a clear indicator when the chat composer's Worker picker is overriding project defaults.
2. **Phase 2 — Structural upgrade (Option A):**
   - Unify General + Project settings behind one `SettingsShell` with the three-scope switcher (`This project` · `This computer` · `This device`) and persistent scope banner.
   - Auto-select the only connected computer when `backends.length === 1` so **AI accounts**, **Your name**, and **Pair a device** are 1 click away.
   - Unify `Pair another device` vs. `Copy server list`, move `Software updates` onto the computer view, put `Monthly plan price` next to each subscription in `AI accounts`, and add a direct `"Connect a new app"` bridge from `This project → Tools & skills`.

### Open choices for the owner

1. **Vocabulary for "Backend" and "Coordinator/Workers":** Should Kemiri switch to plain words (`Computer` / `Main assistant` / `Helper agents` / `Connected apps`) everywhere, or keep technical terms like `Backend` and `MCP` as secondary subtitles for power users?
2. **How aggressive should Option A vs. Option C be right now?** Start directly with Option A's unified scope switcher, or ship Phase 1 (cleanup inside the current two-tree shell) first?
3. **Composer worker picker behavior:** Should picking a worker model in the chat composer stay a separate synced override (just made clearly visible with a `Reset` button), or should it simply become a quick shortcut for changing the project's #1 worker model?
4. **Device-wide reading preferences (`Wrap code`, `Timeline order`, `Image compare`):** Should they stay silent inline toggles, or also appear under `This device → Look & feel → Reading` so people can see and change them in one place?
5. **Non-coding vs. coding projects:** Should software-specific settings (`Tickets & pull requests`, `Software delivery`, `Visual proof of screen changes`, `Workspace storage`) live inside `Advanced` for all projects, or auto-appear only when the project folder is a Git/jj repository?

---

*See the companion interactive HTML mockup (`settings-ux-mockup.html`) to click through Option A across all three scopes (`This project`, `This computer`, and `This device`), including the `Advanced` drawer, notification presets, and mobile/desktop layouts.*
