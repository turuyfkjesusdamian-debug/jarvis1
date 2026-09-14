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
GitHub Actions instead). 127/127 web-app tests pass (`cd app && npm test`),
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
  is no separate "realtime session" concept.
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
- **Tests** (`app/tests/`, 127 tests / 20 files): indexer, retrieval,
  reader (incl. path-traversal rejection), both memory tiers + the
  persistence heuristic (incl. the question-vs-statement fix), the
  forget-command parser and its confirm-then-act flow (asks before
  deleting, cancels on anything but "sí", never lets the forgotten text
  get re-persisted via `shouldPersist`), session history surviving a new
  `JarvisCore` instance, every tool group, the registry's
  validation/permission/confirmation logic, intent classification (incl.
  recall questions), an end-to-end `JarvisCore` flow (including a test
  that a note containing "ignore all previous instructions" is treated as
  inert data, per `JARVIS/SECURITY.md`, and tests for the
  conversational-reply path with/without a key and on failure), the
  Gemini + ElevenLabs clients with `fetch` mocked (no network, no real API
  key needed), and the auth gate's session signing/verification logic
  (`tests/server/auth.test.ts`) —
  `vitest.config.ts` forces
  `GEMINI_API_KEY`/`ELEVENLABS_API_KEY`/`ELEVENLABS_VOICE_ID`/`JARVIS_APP_PASSWORD`
  empty for every test run regardless of the local `app/.env`.
- **Android companion app** (`android/`, milestone 1 of 2 confirmed
  working on the user's real phone — see `JARVIS/ARCHITECTURE.md` §
  Decisions): a Kotlin app with a login screen (server URL +
  `JARVIS_APP_PASSWORD`) and a "test message" button that exercises
  `/api/auth/login` → `/api/chat` → `/api/tts` end to end, reusing the
  exact same backend the web UI talks to. Built by
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
  on. **Four on-device actions added, all processed entirely on-device**
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
  "reproduce/busca X
  en YouTube" and "abre X" need **no confirmation** (opening an app or a
  search page affects no one but the user) and use the same
  notification-launch mechanism. "Jarvis apágate" stops the listener and
  fully closes the app, also no confirmation needed. See
  `JARVIS/SECURITY.md` § Android app actions and
  `JARVIS/ARCHITECTURE.md` § Decisions for the full design and the
  confirmation-vs-not distinction.

## What's missing / next steps

- **"Abre X" and the YouTube search command need a real-device test** —
  untested outside this environment, same constraint as every Android
  feature so far. Needs confirming: the `<queries>` declaration actually
  surfaces third-party apps (not just JARVIS itself) via
  `queryIntentActivities`, common app names resolve correctly, and the
  YouTube search-results page opens as expected via the tap-to-open
  notification.
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
