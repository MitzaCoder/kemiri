# Kemiri for Android

Native Jetpack Compose client, Kotlin namespace `io.github.mitzacoder.kemiri` (public application ID `io.github.mitzacoder.aiki`), Android 12+
(API31). Streaming Markdown/tool transcripts, questions, image attachments,
coordinator, background job and worker navigation, artifact previews and downloads.
Pilot.7 adds Answers, Classic task details with Live transcript links, Glance
usage charts and subscription controls. Per-coordinator model pickers are web only.

Jarvis and Neutral support system/light/dark. Jarvis uses restrained gradients,
static-by-default orbs, a glass-like composer and Lucide controls. This is **not
Haze blur**. Compact bundled syntax grammars/fonts are not every reference asset.
In-app alerts work while Kemiri is open. The public APK does not include push;
Firebase Cloud Messaging below is for operator-configured builds.

## Pilot release builds

See `docs/RELEASE.md` at the repository root for the owner-only release procedure.
`sign-release.sh` builds a neutral, no-push APK with explicit empty private properties
and scrubbed environment; it never reads operator Android configuration. Signing is
local, with an external owner-held keystore and password file, never GitHub secrets.

Set `-Pkemiri.version=v0.1.0-pilot.7` (or `KEMIRI_RELEASE_VERSION`; tag workflows also
read `GITHUB_REF_NAME` when `GITHUB_REF_TYPE=tag`). `versionName` drops `v`.
`versionCode = major*100000000 + minor*1000000 + patch*10000 + stage`, where
pilot N uses N (1–9998) and stable uses 9999. Major is 0–20, minor/patch 0–99.
Thus pilot.1 is 1000001, pilot.2 is 1000002, pilot.3 is 1000003, pilot.4 is 1000004, stable 0.1.0 is 1009999;
the next patch sorts after stable. Never reuse a distributed code or change schemes
without preserving monotonicity. No release input selects `0.1.0-pilot.7`, code 1000007.
`:app:checkReleaseVersion` runs parser/order regressions; malformed release inputs fail.

Settings → About and licences is available offline. Sora's LGPL notice/full text,
pinned source links, replacement instructions and font/Termux notices are APK assets.
Google's OSS licenses plugin 0.13.0 generates the dependency catalogue from the
release dependency list, shown by its bundled licence viewer. Debug builds deliberately
show that plugin's placeholder catalogue; verify the real catalogue on a release build.
`bundle-release-notices.sh` includes that generated catalogue, exact upstream Sora
source (hash-checked) and matching Kemiri source for relinking. Publisher review is still
required; see `licenses/RELINKING.md`, not a blanket compliance claim.

## Install and run

```sh
adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.github.mitzacoder.aiki/io.github.mitzacoder.kemiri.MainActivity
```

On this host use the isolated emulator wrapper, never default adb:

```sh
apps/android/verification/device.sh start
apps/android/verification/device.sh install apps/android/app/build/outputs/apk/debug/app-debug.apk
# Only while the owned scratch real server is running:
apps/android/verification/device.sh adb reverse tcp:4790 tcp:4790
```

Parallel work gets its own device: `HARNESS_ANDROID_DEVICE=a` … `z` on every `device.sh` call selects
`emulator-5582` … `5632` with its own state under `~/scratch/android-cache/device-<x>`, backend port `4800` … `5050`
(reversed at start, `device.sh env` prints them) and captures under `~/scratch/android-screens/track-<x>`. All share
the read-only system image and the adb server on 5038. The wrapper reads the local application ID (or
`HARNESS_ANDROID_PACKAGE`) for launch and demo commands. Unset is the original `emulator-5580` / 4790.

## Build and test

From the checkout root, using Bun only:

```sh
bun install --frozen-lockfile
bun apps/android/scripts/generate-protocol.ts --check
bun test apps/android/verification
bun run tsc --noEmit -p apps/android/verification/tsconfig.json
apps/android/scripts/build.sh :app:testDebugUnitTest :app:assembleDebug :app:lintDebug --rerun-tasks
# To include BOTH live transport and fixture opt-ins, see verification/README.md.
```

Pinned: Nix/JDK21, SDK/build-tools37, AGP9.4.1 built-in Kotlin2.4.20,
Compose BOM2026.09.00. `scripts/build.sh` reuses realized host tools (or
`nix develop` elsewhere). Writable tools/caches/temp files stay in
`~/scratch/android-cache`. `build.sh` locks its own checkout (`.gradle/build.lock`); separate checkouts build at
once over the shared Gradle user home, which Gradle locks itself. No outer `flock` is needed.
Reuse the existing emulator image; monitor scratch free space (~14GB at this
checkpoint). Output: `app/build/outputs/apk/debug/app-debug.apk`.

## Kemiri identity and compatible upgrades

The Kotlin namespace and source paths use `io.github.mitzacoder.kemiri`. The
public application ID stays `io.github.mitzacoder.aiki`; private builds retain
`harness.applicationId`. Signing, preferences/notification prefixes, DataStore
files and keystore aliases are installation identity, not display names. The old
MainActivity launcher alias and configurable pre-T70 alias remain reachable.
Connect previews accept `kemiri://connect`, `aiki://connect` and
`harness://connect`; configured HTTPS app/pairing/OAuth origins do not move.
Releases publish only canonical `kemiri-*` APK and notices assets, with checksum sidecars.

## Remote MCP settings

Backends advertising `mcp-servers` expose Settings → Backends → MCP servers.
Add a backend-provided preset or named URL, sign in or paste a write-only token,
refresh tools, and choose Off/Ask/Allow per tool. Tool metadata stays plain text;
filtering and a bounded lazy list keep large catalogues compact. Project settings
→ MCP starts disabled, with separate coordinator, workers and background roles.
Approvals use the ordinary board question card with exact arguments.

OAuth opens a Custom Tab using `harness.appOrigin` / `HARNESS_APP_ORIGIN` as the
backend-allowlisted web origin, not the backend socket origin. Discovery and hello
do not report a per-backend web origin; the backend operator must allow the build
origin or sign-in reports an error. The manifest handles the exact HTTPS path
`/mcp/oauth/callback` on that configured host, using the same user-selected App
Link mechanism as project links. No verified-domain claim is made. Completion
matches OAuth state to the initiating in-memory backend session and reuses its
client. Paste callback URL is available when the browser cannot return. Cancel
and progress follow `mcp.oauth.changed`. No token, callback or pending flow is
saved on the phone; after process death, start sign-in again.

## Push notifications (FCM) and project links

Firebase is optional at build time. The build reads the app's `google-services.json` from **outside the repo**, named
by the Gradle property `harness.googleServicesJson` or the environment variable `HARNESS_GOOGLE_SERVICES_JSON` (`~`
expands), and puts only its four public client values into `BuildConfig`; never copy the file into the checkout.
Without it the app builds and runs, and the Notifications screen says push is unavailable.

```sh
HARNESS_GOOGLE_SERVICES_JSON=~/scratch/android-sync/firebase/google-services.json \
  apps/android/scripts/build.sh :app:assembleDebug
```

Each backend needs the Firebase project's service-account key (Firebase console → Project settings → Service
accounts → Generate new private key) at `<data dir>/notifications/fcm-service-account.json` (or
`KEMIRI_FCM_KEY_FILE`), mode 0600, then a restart; it logs `FCM on for Firebase project …` or `FCM off`.
Never commit or print it. The app's Notifications screen turns push on (asks for POST_NOTIFICATIONS on Android 13+),
registers the FCM token with every backend that has `fcm-push`, shows each backend's registration, last push and
"Send test", and keeps kinds, quiet hours and muted projects (the bell in a chat header mutes that project).

Web project links (`https://harness.example.test/b/<backend>/projects/<id>`, with `/threads/<t>`,
`/workers/<w>`, `/settings`, `?task=`, `#thread-<id>`, `#entry-<n>`) open in the app once the user lets it open that
domain (system settings → Kemiri → Open by default → Add link; on the emulator `adb shell pm
set-app-links-user-selection --user 0 --package io.github.mitzacoder.aiki true harness.example.test`). The
`<backend>` is the web's ID, the slug of the name the backend was added with (`harness-pc`, `harness-vm` for the
published list); the app matches it by the slug of each backend's name, then by its host's first label, so a rename on
either side still opens. An unknown one closes any panel and opens the drawer with an "Unknown backend" note.

Debug builds accept what FCM would deliver from adb (it holds DUMP), for tests without Google:

```sh
D=apps/android/verification/device.sh
$D adb shell am broadcast -a io.github.mitzacoder.aiki.DEBUG_PUSH -p io.github.mitzacoder.aiki --es token fake-token  # turns push on
$D adb shell am broadcast -a io.github.mitzacoder.aiki.DEBUG_PUSH -p io.github.mitzacoder.aiki --es payload "'<NotificationPayload JSON>'"
```

## Optional relay plumbing (no account UI yet)

`NotificationSettings.relayEnabled` defaults off, including upgrades. Ordinary app use, pairing and direct FCM do not
need a relay account; off does not open the relay store or client. The private build value `harness.pushRelayUrl` /
`HARNESS_PUSH_RELAY_URL` pins a v1 base URL. Empty means unavailable. HTTPS is required; debug alone permits literal
loopback/localhost and emulator-host HTTP. There is no backend/message endpoint override.

The `features/notifications/relay` package contains encrypted backup-excluded storage, typed management HTTP,
persisted enrollment/token replacement, signed-in backend registration, account deletion and the pure receive router.
See [DESIGN](../../docs/DESIGN.md#android-relay-plumbing-t96) and the
[backend contract](../../docs/push-relay-backend-v1.md). Firebase Auth is deliberately absent: `RelayAccount` still
returns not-signed-in in Android composition. The next task supplies account UI and the real token provider.

Debug builds have one additional shell-only (DUMP-permission) receive seam. On a separately authorized test emulator,
deliver captured challenge or envelope JSON through the real router; no seam turns relay on or enrolls the device:

```sh
adb shell am broadcast -a io.github.mitzacoder.aiki.DEBUG_RELAY -p io.github.mitzacoder.aiki --es aiki '<captured JSON>'
```

Use the installed package's name if privately configured differently. `:app:checkReleaseRelaySeam` builds the merged
release manifest and fails if this component/action is present. The seam has no release source or main-manifest entry.
No emulator/device was used to implement this plumbing; all new verification is JVM/fake HTTP.

## Optional relay account build values

Relay accounts are optional (D51). Only Settings → Notifications → Phone notifications through the relay opens
sign-in. No account is requested during install, first run, backend pairing or normal project use. Direct push stays
available to backends that do not support relay notifications. A build with no private values still builds and works;
relay settings explain that sign-in is unavailable.

Alongside `harness.pushRelayUrl` / `HARNESS_PUSH_RELAY_URL` and the existing external Firebase client config:

| Gradle property | Environment variable | Meaning |
| --- | --- | --- |
| `harness.relayGoogleClientId` | `HARNESS_RELAY_GOOGLE_CLIENT_ID` | Web OAuth client ID, never the Android client ID or a secret |
| `harness.relayEmailLinkDomain` | `HARNESS_RELAY_EMAIL_LINK_DOMAIN` | Hosting host only; HTTPS App Link with exact `/__/auth/links` path |
| `harness.relayPrivacyContact` | `HARNESS_RELAY_PRIVACY_CONTACT` | Operator contact shown in consent |

All default to empty. D54 starts the pilot with email links only: an empty Google Web client ID hides the Google
button and its name/photo privacy point, without disabling email sign-in. A configured Web client ID offers both
methods. The debug fake Google credential switch also counts as configured, but never in a release build.
The email host's release SHA-256 App Links association and Google package/certificate setup
are operator responsibilities. Email uses current Hosting links, not Dynamic Links. Paste recovery checks the exact
host/path before Firebase checks the code. The address is kept locally until completion; links/codes are never logged.
Sign-out and turn-off are distinct from deletion; backend sign-ins remain independent.

Debug source set only:

| Gradle property | Environment variable | Meaning |
| --- | --- | --- |
| `harness.relayAuthEmulator` | `HARNESS_RELAY_AUTH_EMULATOR` | Loopback/Android emulator host:port |
| `harness.relayFakeGoogle` | `HARNESS_RELAY_FAKE_GOOGLE` | Synthetic Google credential, defaults false |
| `harness.relayFakeFcm` | `HARNESS_RELAY_FAKE_FCM` | Synthetic FCM token, defaults false; skips Messaging initialization |

Fake controls require the Auth emulator and the synthetic `demo-aiki-relay` project. Demo client config must be
created outside the repo with obviously fake public values. Never supply real Firebase config for emulator proofs.
The manifest keeps FCM auto-init off. `:app:checkReleaseRelayAuth` inspects the release APK DEX for debug controls and
providers; `:app:checkReleaseRelaySeam` checks the merged release manifest. Neither debug fake exists in release.

Dependencies: Firebase Auth 25.0.0, Credential Manager and Play services bridge 1.6.0, Google ID 1.2.1. See
`licenses/relay-dependencies.md` for attribution and terms. The T97 debug APK grew from 59,319,993 to 68,015,434
bytes (+8,695,441 bytes, including UI and dependencies); these are debug, not release-signed APKs.
Real Google sign-in, email delivery/App Links verification,
FCM delivery, Play services behavior and release-signed sideloading require separate consented real-service testing.

## Verification: actual behavior versus appearance

See [the verification guide](verification/README.md) for the emulator and test
fixtures. The real-server fixture uses a deterministic faux model for transport,
conversation and tool checks. The synthetic Usage fixture checks rendering, not
provider sign-in, actual subscription usage or rate limits. Screenshots do not
prove physical camera, real-network pairing or push delivery.

## Architecture and stable interfaces

Kotlin: `app/src/main/kotlin/io/github/mitzacoder/kemiri/`:

- `core/`, `data/`, `protocol/`: tolerant serialization, Chord, one WebSocket per
  backend, generated RPC/events, lifecycle watches and DataStore.
- `navigation/`: saved backend/project/thread/worker routes; full-screen phone
  panels and tablet side panels with movable composition retaining editors.
- `features/chat/`, `features/panels/`, `features/settings/`, `features/usage/`:
  scoped feature screens; main/background composers writable, workers read-only.
- `features/tasks/`: pure ports of the web's `lib/tasks.ts` and `lib/task-chat.ts` (tested against the same cases),
  `TaskLinks`/`LocalTaskLinks` and the task sheet shown for `Destination.Task`. `features/refs/`: the `RefLinks`
  seam and `RefChips`.

The generator turns unions told apart by a constant (`RefStatus`, `RefDetails`, `ScheduleSpec`, `AuthEvent`) into
sealed interfaces whose unknown variants decode as `Unknown<Name>` with their JSON; string-literal unions are
`String`. Build generated DTOs with named arguments. `data/FeatureRequests.kt` holds the requests that need a hello
feature (refs, cache stats, storage, task history, board notes, prompt cache and link settings) and refuses them with
`unsupported_feature` otherwise. `data/ProjectBoard.kt` is the one live board per project (`context.board`). Rendered
Markdown takes `LocalTextLinkers` to turn task mentions and refs into links.

Entry points remain `ChatScreen`, `ArtifactScreen`, `PanelsScreen`,
`SettingsScreen`, `UsageScreen` with `ProjectScreenContext`. Reuse the application
repository's BackendSession/client; do not create a socket per panel. Feature
checks come from negotiated hello. Collect before snapshots, cancel by lifecycle,
and protect pushes from stale reads. Provider refresh publishes to the shared
model catalog. ConversationWatch owns a subscription, not the socket.

Mutations are never blindly replayed. Ambiguous retry retains its admission ID,
not a transport correlation ID. Composer attachments live in a ViewModel with
saveable pending identity/drafts. Chord `t` removes a UTF16 **prefix**, not suffix.
Generated DTOs preserve unknown/open data; required nulls are encoded, optional
nulls omitted unless explicitly cleared. Android work does not change server,
protocol, TypeScript client or web sources.

Connect payloads are validated all-or-nothing and always previewed. Supported:
`harness://connect#v1.…` and canonical HTTPS `/connect#v1.…`. Camera hardware is
optional; ZXing4.3.0/CaptureActivity is packaged, not physically verified. Signed
media capabilities are short-lived in memory, never persisted/telemetried.
Atkinson Hyperlegible Next (the web's sans) and JetBrains Mono keep their bundled OFL licenses in `licenses/`.
