---
type: state
scope: project-status
updated: 2026-09-14
---

# Project status

## Current state: v1 (text + voice-ready) working end to end

First development session, completed in full through Phase 10 (hardening),
plus same-day follow-ups: ElevenLabs speech output was added, then removed,
then re-added; the UI was redesigned around an audio-reactive, drag-to-spin
particle sphere; several text-mode bugs found via live user testing were
fixed; OpenAI was removed entirely (billing became a blocker for the user)
in favor of a three-part split (browser Web Speech API for listening,
Gemini for general-intent text, ElevenLabs for speech output); JARVIS was
given an explicit British-butler personality; the app became installable
as a PWA with an optional password gate so it's usable only by the user it
belongs to; and — in progress — a native Android companion app (`android/`)
was started for a voice command that works without opening the web app
first (see `JARVIS/ARCHITECTURE.md` § Decisions for the full rationale on
each, including why this sandbox can't build it directly and builds it via
GitHub Actions instead). 129/129 web-app tests pass (`cd app && npm test`),
`npm run typecheck` and `npm run build` are clean. The Android app has no
automated tests yet — it can't be exercised in this environment at all;
see "What's missing" below.

## What exists

- **Docs** (`JARVIS/`): AGENTS, ARCHITECTURE, CONFIG, MEMORY, PERSONA,
  TOOLS, SECURITY, DEVELOPMENT, plus root `CLAUDE.md`. Kept as an index,
  not a copy of the vault — see `JARVIS/AGENTS.md`.
- **Vault skeleton**: `JARVIS/{STATE,MEMORY,LOGS,INDEX}` seeded with
  starter files; `Projects/`, `Tasks/`, `Notes/`, `Daily/`, `People/`,
  `Resources/` created empty (`.gitkeep`) for the user's own content.
- **Obsidian layer** (`app/src/obsidian/`): `VaultIndexer` (metadata-only
  index, excludes `JARVIS/INDEX` and `JARVIS/LOGS`), `VaultReader`
  (path-traversal-safe read/write/append, section extraction), `retrieval`
  (folder/tag/frontmatter/keyword scoring, no vector DB — see
  `JARVIS/ARCHITECTURE.md` § Retrieval strategy for why).
- **Memory engine** (`app/src/memory/`): session (in-process, capped at 40
  turns, now persisted as JSON to `JARVIS/STATE/session-history.json` and
  reloaded on startup so a Render cold start no longer wipes the
  conversation — see `JARVIS/MEMORY.md` § 1), short-term
  (`JARVIS/STATE/current-day.md`, date-based rotation), permanent
  (`JARVIS/MEMORY/*.md`, one bullet per fact) behind `MemoryEngine`, plus
  the `shouldPersist` heuristic (conservative: explicit "remember" >
  stable preference > project/people mention > nothing; skips questions
  so "¿qué recuerdas sobre el proyecto?" doesn't get saved as if it were
  a fact). Saying "olvida X" now actually forgets it, via a two-turn
  confirm-then-act flow in `JarvisCore` (reads the matching fact back,
  waits for an explicit "sí") — see `JARVIS/MEMORY.md` § Forgetting.
- **Tools** (`app/src/tools/`): full set from `JARVIS/TOOLS.md` —
  `obsidian.{searchNotes,readNote,createNote,updateNote,appendToNote}`,
  `tasks.{listTasks,createTask,completeTask,updateTask}`,
  `memory.{searchMemory,saveMemory,forgetMemory}`,
  `system.{getCurrentTime,getSystemStatus}`. Schema-validated (zod),
  permission-gated (`read`/`write`/`destructive`), logged, structured
  results — see `ToolRegistry.invoke`.
- **Core** (`app/src/core/`): `classifyIntent` (deterministic keyword
  classifier, including memory *recall* questions like "qué recuerdas",
  not just save instructions), `ToolRouter` (executes calls, logs to
  session memory + `JARVIS/STATE/last-actions.md`, reindexes the vault
  after any write/destructive call), `JarvisCore` facade. Replies:
  tasks/schedule/notes/memory intents use a deterministic templated
  reply (`core/respond.ts`, no model call); "general" chit-chat calls
  Gemini (`voice/geminiClient.ts`, `GEMINI_MODEL`) when `GEMINI_API_KEY`
  is set, falling back to the template if not configured or the call
  fails. Text chat and voice mode share this exact same code path — there
  is no separate "realtime session" concept. **General chit-chat also
  brings up remembered facts unprompted**: `JarvisCore.buildSystemPromptWithMemory`
  appends up to 6 relevant-or-recent `PermanentMemory` facts to Gemini's
  system prompt as labeled data (never an instruction), so JARVIS can
  reference something it was told before without the user having to
  explicitly ask "¿qué recuerdas?" — see `JARVIS/MEMORY.md` § "Bringing
  facts up unprompted".
- **Voice** (`app/src/voice/`): two independent, provider-specific
  clients — `geminiClient.ts` (general-intent text replies) and
  `elevenLabsClient.ts` (speech synthesis, `POST /api/tts`). Speech
  *input* is handled entirely client-side by the browser's Web Speech API
  (`SpeechRecognition`), so there's no server-side STT code at all. OpenAI
  (Realtime API and Chat Completions) has been removed completely — see
  `JARVIS/ARCHITECTURE.md` § Decisions for the full history (ElevenLabs
  was added, removed, then re-added the same day; OpenAI was replaced
  last).
- **Server** (`app/src/server/`): Express app serving the static UI plus
  `/api/{status,chat,tools,tts,auth/login,auth/logout}`. `/api/tools/:name`
  requires `confirmed: true` in the body for destructive tools. An
  optional password gate (`server/auth.ts`, active when
  `JARVIS_APP_PASSWORD` is set) sits in front of everything except the
  login endpoint and PWA metadata — see `JARVIS/SECURITY.md` § Access
  control.
- **UI** (`app/public/`): a purple, audio-reactive particle sphere
  (`orb.js`, pure Canvas 2D, no dependencies) as the visual centerpiece —
  real amplitude from ElevenLabs's TTS audio (plus a lighter reaction to
  the mic) drives its scale/brightness/spin speed, and it can be
  dragged/flicked to spin manually with inertia (unclamped on both axes).
  Conversation, tool activity, errors, and config are tucked into a
  collapsible panel so the sphere stays the focus. Text chat works
  without any API key; voice mode adds mic transcription via
  `SpeechRecognition` and spoken replies via `/api/tts`, both optional
  and independently gated by browser support / `ELEVENLABS_*` config.
  Installable as a PWA (`manifest.json`, `sw.js`, purple orb icon set in
  `public/icons/`) — "Add to Home Screen" gives it its own icon and a
  full-screen, no-address-bar window. `login.html` is the gate page shown
  when `JARVIS_APP_PASSWORD` is set and no valid session exists yet.
- **Tests** (`app/tests/`, 129 tests / 20 files): indexer, retrieval,
  reader (incl. path-traversal rejection), both memory tiers + the
  persistence heuristic (incl. the question-vs-statement fix), the
  forget-command parser and its confirm-then-act flow (asks before
  deleting, cancels on anything but "sí", never lets the forgotten text
  get re-persisted via `shouldPersist`), session history surviving a new
  `JarvisCore` instance, every tool group, the registry's
  validation/permission/confirmation logic, intent classification (incl.
  recall questions), an end-to-end `JarvisCore` flow (including a test
  that a note containing "ignore all previous instructions" is treated as
  inert data, per `JARVIS/SECURITY.md`, tests for the conversational-reply
  path with/without a key and on failure, and tests that remembered facts
  get folded into the Gemini system prompt unprompted — both when
  keyword-relevant and as a recency fallback), the Gemini + ElevenLabs
  clients with `fetch` mocked (no network, no real API key needed), and
  the auth gate's session signing/verification logic
  (`tests/server/auth.test.ts`) —
  `vitest.config.ts` forces
  `GEMINI_API_KEY`/`ELEVENLABS_API_KEY`/`ELEVENLABS_VOICE_ID`/`JARVIS_APP_PASSWORD`
  empty for every test run regardless of the local `app/.env`.
- **Android companion app** (`android/`, milestone 1 of 2 confirmed
  working on the user's real phone — see `JARVIS/ARCHITECTURE.md` §
  Decisions): a Kotlin app with a login screen (server URL +
  `JARVIS_APP_PASSWORD`) and a real chat screen (not just a "test
  message" box anymore) that exercises `/api/auth/login` → `/api/chat` →
  `/api/tts` end to end, reusing the exact same backend the web UI talks
  to. **Now visually designed to match the web UI**: `OrbView.kt` is a
  native port of `app/public/orb.js`'s purple particle sphere (same
  ring/rotation math, drag-to-spin with inertia, real audio-reactive
  energy — a fixed pulse while waiting for a reply, then live TTS
  waveform data via `android.media.audiofx.Visualizer` while JARVIS
  speaks), and `activity_main.xml` mirrors the web layout: topbar with
  status pills, the orb centered, a scrolling chat transcript with
  user/assistant bubbles, a pill-shaped input row, and the server
  URL/password fields tucked into a collapsible "Detalles" panel instead
  of always showing. This is a hand-maintained native copy of the web
  design, not a shared component — a future change to the web's
  orb.js/styles.css won't automatically reach here, see
  `JARVIS/ARCHITECTURE.md` § Decisions. Built by
  `.github/workflows/android-build.yml` on GitHub Actions (this sandbox
  can't reach the Android SDK servers to build it directly) and published
  to a GitHub Release (`android-latest`) since Actions artifacts are also
  unreachable from this sandbox (Azure Blob Storage); handed to the user
  as a sideloadable APK, signed with a committed keystore
  (`android/jarvis-release.keystore`) so updates install over the old
  version. Login, chat, and speech playback all verified live by the user
  — text and audio both work correctly from the native app. **Milestone 2
  confirmed working live**: `JarvisListenerService`, a foreground service
  that listens continuously via Android's `SpeechRecognizer` for "oye
  jarvis", extracts whatever follows as the command (or, said alone,
  acknowledges locally via on-device `TextToSpeech` and treats the next
  utterance as the command), and round-trips it through the same
  `/api/chat` + `/api/tts` pipeline — toggled from a button in
  `MainActivity`, which also prompts for the battery-optimization
  exemption and restarts itself after a reboot (`BootReceiver`) if it was
  on. **Six on-device actions added, all processed entirely on-device**
  (never touching the server): "envíale un mensaje a X que diga Y" and
  "llama a X" **require an explicit spoken "sí" first** (confirmed
  working live, after fixing two real bugs found via live testing — a
  self-hearing bug that made every confirmation resolve to "Cancelado"
  regardless of what was said, and Android silently blocking a background
  Service from actually opening WhatsApp/the dialer, fixed by launching
  via a tap-to-open notification instead of directly). Contact name
  matching is nickname-tolerant (`namesMatch` in
  `JarvisListenerService.kt`): saying "Juan" now finds a contact saved as
  "Juanito" and vice versa (bidirectional substring match, both on the
  full name and each word, with a minimum-length guard) — the
  confirmation prompt always reads back the real resolved contact name
  first, so a wrong guess is still caught before anything sends.
  "reproduce/busca X en YouTube", "abre X", "cómo llego a/de X (a Y)", and
  "busca X cerca" need **no confirmation** (opening an app or a search/
  route page affects no one but the user). The Maps commands open
  Google's own public "Maps URLs" links (no API key, no new Android
  permission — Maps supplies current location itself) but don't read the
  answer back out loud; the user was asked and chose this free/no-setup
  version over the spoken-answer one, which would need a Google Maps
  Platform API key and a billing account on file. "Jarvis apágate" stops
  the listener and fully closes the app, also no confirmation needed. See
  `JARVIS/SECURITY.md` § Android app actions and
  `JARVIS/ARCHITECTURE.md` § Decisions for the full design and the
  confirmation-vs-not distinction.
- **App-launching commands can now open directly, skipping the
  notification** — an optional "Mostrar sobre otras apps"
  (`SYSTEM_ALERT_WINDOW`) permission, requested the same way as the
  battery-optimization exemption, lets `JarvisListenerService` hold a
  permanently invisible 1×1 overlay window that satisfies one of
  Android's background-activity-launch exemptions; every command above
  (open app, YouTube, Maps, WhatsApp, calls) tries a direct
  `startActivity()` first and only falls back to the tap-to-open
  notification if that permission was never granted. JARVIS never draws
  anything visible with this permission. See `JARVIS/SECURITY.md` §
  Android app actions and `JARVIS/ARCHITECTURE.md` § Decisions.
- **Orb size still being tuned live with the user — currently 280dp** —
  went full-screen-width (too big), then 220dp (too small), now 280dp as
  a middle ground not yet confirmed by the user. Keeps the denser
  particles (~1.5x per ring), bigger particle size, and bumped
  `baseRadius` (0.34→0.38) from the same tuning pass throughout (no
  device profiling behind any of these numbers — first thing to dial back
  if a real phone drops frames).
  `MainActivity` also gained: a "Comandos" button (a plain `AlertDialog`
  listing every voice command, deliberately separate from "Detalles"); a
  "Leer las respuestas de JARVIS en voz alta" switch inside "Detalles"
  that mutes automatic TTS playback for typed chat replies only (the
  background listener always speaks); and a "Volumen de la voz de
  JARVIS" slider, also in "Detalles", backed by one `"jarvis_volume"`
  preference that both `MainActivity` and `JarvisListenerService` read.
  Separately: general chit-chat replying with only "Entendido, señor."
  turned out to be an existing, silent gap — the server already sends
  *why* it fell back to the template (`debugError`, e.g. a Gemini
  key/quota problem) and the Android client already parsed that field,
  but `MainActivity` discarded it instead of showing it. Now surfaced as
  a small note in the chat transcript (`addSystemNote`) — this doesn't
  fix whatever's actually wrong with Gemini on the user's deployment
  (unknown until the note's text is seen), it just makes the next
  occurrence diagnosable instead of a silent mystery. See
  `JARVIS/ARCHITECTURE.md` § Decisions.

## What's missing / next steps

- **Why Gemini calls are failing on the user's Render deployment is
  still unknown** — the "Entendido, señor." bug report turned out to be
  an existing silent-failure gap in the Android app (now fixed, see
  above), not a new regression, but the *underlying* Gemini failure
  itself hasn't been diagnosed yet. Next step: get the actual
  `debugError` text from the app's new note next time it happens, and
  check Render's env vars / logs for `GEMINI_API_KEY` validity and
  quota.
- **The orb's current 280dp size still needs the user's confirmation** —
  after full-width (too big) and 220dp (too small), same
  untested-outside-this-sandbox caveat as every other Android UI change.
  Worth confirming specifically: 280dp actually reads as "bigger than
  220dp but still leaves clear room for the chat" rather than needing a
  fourth pass, the corners of the square still show background (expected
  — a round sphere can't reach a square's corners, not a bug), ~540
  particles/frame doesn't drop frames
  on the software-rendered buffer canvas, and the volume slider actually
  changes both the chat screen's and the background listener's voice.

- **The direct-launch overlay permission needs a real-device test** — the
  documented Android exemption (`SYSTEM_ALERT_WINDOW` + an active
  `TYPE_APPLICATION_OVERLAY` window) has never been exercised on real
  hardware from this sandbox. Needs confirming: granting "Mostrar sobre
  otras apps" then restarting the listener actually makes "abre X" open
  the app with no notification at all, that MIUI doesn't add its own
  extra layer of restriction on top of stock Android's, and that
  declining the permission still leaves every command working exactly as
  before (notification fallback).
- **The redesigned Android UI (`OrbView`, the new `activity_main.xml`)
  needs a real-device look** — untested outside this environment like
  every Android UI change so far. Worth specifically confirming: the orb
  animates smoothly (Choreographer-driven, should hold 60fps on a modern
  phone, but MIUI/low-end devices can behave differently), the
  `PorterDuff.Mode.ADD` glow actually renders (additive blending onto a
  plain `Bitmap` canvas should be safe, but hasn't been seen on real
  hardware), the `Visualizer`-driven energy visibly reacts while JARVIS
  speaks, and the collapsible "Detalles" panel doesn't hide the
  login/server fields so well that the user can't find them the first
  time they open the app.
- **"Abre X", the YouTube search command, and the new Maps commands need
  a real-device test** — untested outside this environment, same
  constraint as every Android feature so far. Needs confirming: the
  `<queries>` declaration actually surfaces third-party apps (not just
  JARVIS itself) via `queryIntentActivities`, common app names resolve
  correctly, the YouTube search-results page opens as expected via the
  tap-to-open notification, and Google Maps actually opens with the
  route/nearby search pre-filled (rather than, say, falling back to a
  browser if the Maps app isn't set as the default handler).
- **The spoken-answer Maps tier remains a designed-for-later option** —
  the user was asked to choose between "just opens Maps" (shipped, free,
  no new key) and "JARVIS speaks the travel time / nearest place out
  loud" (needs a Google Maps Platform API key + a billing account on
  Google's side); they picked the free version for now. If they later
  want the spoken version, it needs a new `maps.*` tool on the *web*
  backend (not on-device — a real API call, unlike the deep links), a
  `GOOGLE_MAPS_API_KEY` following the same secret-handling rules as
  `GEMINI_API_KEY`/`ELEVENLABS_API_KEY`, and the Android app forwarding
  these specific commands to `/api/chat` instead of matching them
  on-device.
- **An external uptime pinger needs to be pointed at `GET /healthz`** to
  stop Render's free tier from spinning the service down after 15 minutes
  idle — this is what caused the "sometimes instant, sometimes 30+
  seconds" delay the user reported once the Android wake-word listener
  made idle periods between uses obvious. The endpoint exists
  (unauthenticated, reveals nothing); the user still needs to set up the
  pinger itself (e.g. a free UptimeRobot monitor, ~5 minute interval) —
  see `JARVIS/ARCHITECTURE.md` § Decisions for why a GitHub Actions
  `schedule:` trigger was considered and rejected (too unreliable at this
  interval on a low-activity repo).
- **Android app milestone 2 (background wake-word listener) confirmed
  working live** — the user tested "oye jarvis" and got it recognized and
  answered correctly, called it "increíble." Boot-persistence
  (`BootReceiver`, restarts the listener after a reboot if it was on)
  shipped right after but its actual reboot behavior on the user's phone
  hasn't been confirmed yet — still depends on MIUI's separate "Inicio
  automático" (autostart) toggle being granted, with no public API to
  request it.
- **Gemini, the deterministic tool flows, ElevenLabs speech output, the
  password gate, and the Android app are all confirmed working live on
  Render and the user's phone** together, end to end. The user's original
  ElevenLabs voice choice (a Voice-Library voice, `402 paid_plan_required`
  on the Free plan) can be restored later if they upgrade their ElevenLabs
  plan or a self-cloned voice works on Free — just swap
  `ELEVENLABS_VOICE_ID` again, no code change needed.
- **The browser Web Speech API voice loop and the PWA install flow
  (web, not the Android app) have each only been exercised once or not at
  all live** — not blocking anything, just not re-verified since the
  Android app became the primary way the user interacts with JARVIS by
  voice.
- **Known, unchanged scope gap**: natural-language voice/text commands
  don't route to write-capable tools (`tasks.createTask`,
  `memory.saveMemory` via explicit command, etc.) beyond the existing
  `shouldPersist` heuristic for memory. This was already true before the
  Gemini swap — Gemini's role, like OpenAI's before it, is scoped to
  general chit-chat only, not tool-calling — so "create a task by voice"
  still won't work; flag this to the user if they expect it.
- Calendar/email/weather/web-search tools, semantic/vector retrieval,
  multi-agent routing, a native desktop shell, and a proactive/background
  daemon are all designed for (see `JARVIS/ARCHITECTURE.md` § 6) but
  intentionally not built — add them only when needed, following
  `JARVIS/TOOLS.md` § "Adding a new tool".
- `express`'s transitive `qs` dependency has a known moderate advisory
  with no non-breaking fix currently available (`npm audit` in `app/`);
  fixing it requires an Express major-version bump, deferred rather than
  done reflexively — revisit next time dependencies are touched.

## Known issues

- None currently open against implemented functionality (all tests green).
  The live-voice caveat above is a coverage gap, not a known bug.

## Decisions

See `JARVIS/ARCHITECTURE.md` § Decisions for the architectural log
(stack choice, no-vector-DB-in-v1, vault+app co-location, the
ElevenLabs add/revert/re-add, the orb UI, and the full OpenAI → Gemini +
ElevenLabs + browser Web Speech API migration).

## How to resume

1. Read `JARVIS/AGENTS.md`, then this file.
2. `cd app && npm install && npm test && npm run typecheck` — should be
   green before you change anything.
3. `cp app/.env.example app/.env` and fill in `GEMINI_API_KEY` for real
   general-chit-chat replies and `ELEVENLABS_API_KEY`/`ELEVENLABS_VOICE_ID`
   for spoken replies; text-mode (`npm run dev`, then open the UI or
   `POST /api/chat`) works with no keys at all otherwise. Voice input
   (the mic button) needs a Chromium-based browser, no key.
4. Whatever you build, update the relevant `JARVIS/*.md` doc and this
   file — see `JARVIS/DEVELOPMENT.md` § "Adding a feature — checklist".
