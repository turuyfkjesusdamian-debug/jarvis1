# ARCHITECTURE.md

## 1. Overview

JARVIS is split into two halves that share a filesystem but not a runtime:

- **The vault** (this repo's root): plain Markdown data — the user's notes,
  the assistant's own memory, and its documentation. No code runs here; it
  is read and written by the app.
- **The app** (`app/`): a Node.js/TypeScript service that indexes the
  vault, holds the tool system and memory engine, talks to Gemini
  (general-intent text replies) and ElevenLabs (speech synthesis), and
  serves a small web UI.

```
┌──────────────────────────┐
│        User (voice)      │
└────────────┬─────────────┘
             │ mic audio, transcribed locally by the
             │ browser's Web Speech API (no server-side STT)
             ▼
┌──────────────────────────┐
│   Browser (public/)       │   app/public
│  SpeechRecognition (in)   │   sends the final transcript as a normal
│  ElevenLabs audio (out)   │   chat message; plays back TTS audio
└────────────┬─────────────┘
             │ POST /api/chat { message }
             ▼
┌──────────────────────────┐
│       JARVIS CORE         │   app/src/core
│ intent → context → plan   │
│      → tool router        │
└───────┬─────────┬────────┘
        │         │
        ▼         ▼
┌─────────────┐ ┌───────────────┐
│   Memory    │ │     Tools     │   app/src/tools
│   Engine    │ │ obsidian/*    │
│(3 tiers)    │ │ tasks/*       │
└─────┬───────┘ │ memory/*      │
      │         │ system/*      │
      ▼         └───────┬───────┘
┌─────────────┐         │
│  Obsidian   │◄────────┘
│Indexer/Read │   app/src/obsidian
└─────┬───────┘
      ▼
┌─────────────┐
│ Vault (.md) │   JARVIS/, Projects/, Tasks/, Notes/, Daily/, People/, Resources/
└─────────────┘
```

## 2. Module boundaries

- `core/` — orchestration only. No direct `fs` access. Depends on
  `memory/`, `obsidian/`, `tools/`. Nothing depends on `core/`.
- `obsidian/` — vault indexing (`VaultIndexer`), targeted reading
  (`VaultReader`), and retrieval scoring (`retrieval.ts`). Pure filesystem +
  markdown parsing; no knowledge of tools, memory tiers, or voice.
- `memory/` — the three memory tiers (`sessionMemory`, `shortTermMemory`,
  `permanentMemory`) behind one `MemoryEngine` facade. Reads/writes
  Markdown under `JARVIS/STATE` and `JARVIS/MEMORY`.
- `tools/` — one file per tool. Each tool is self-contained: schema,
  validation, permission level, implementation, structured result. Tools
  may call into `obsidian/` and `memory/`, never into `core/` or `voice/`.
- `voice/` — two independent, provider-specific clients: `geminiClient.ts`
  (general-intent conversational text replies) and `elevenLabsClient.ts`
  (speech synthesis for any reply). Neither has anything to do with speech
  *input* — that's the browser's job (`public/app.js`, Web Speech API).
  The core has no Gemini/ElevenLabs-specific types; it only sees
  `generateConversationalReply()` and `synthesizeSpeech()`.
- `server/` — HTTP endpoints (`/api/chat`, `/api/tts`, `/api/tools`,
  `/api/status`, `/api/auth/{login,logout}`, `/healthz`), the optional password-gate
  middleware (`server/auth.ts`, see `JARVIS/SECURITY.md` § Access
  control), and static file serving for `public/`.
- `logging/` — one structured logger used everywhere; never `console.log`
  directly in library code.

Dependency direction is strictly: `server → voice/core → memory|obsidian|tools`.
This means any of these pieces (e.g. swap Gemini or ElevenLabs for another
provider, or swap the retrieval strategy for a vector index later) can be
replaced without touching the others.

## 3. Data flow: "JARVIS, ¿qué tengo hoy?"

1. Browser mic audio is transcribed locally by the Web Speech API
   (`SpeechRecognition`, no server round-trip for STT); once a final
   transcript is ready it's sent like any typed message to `POST
   /api/chat { message }`. (Typing in the text box takes the same path.)
2. `core/intent.ts` classifies it as `schedule` (deterministic keyword
   rules — no model call for this step).
3. `core` calls `core/toolRouter`, which validates params against the
   tool's schema and invokes the tool through `tools/registry.ts` (e.g.
   `tasks.listTasks`, `system.getCurrentTime`).
4. The tool (e.g. `tasks/listTasks`) asks `obsidian/retrieval.ts` for the
   minimal context: it consults `JARVIS/INDEX/vault-index.json` to find
   candidate files (by folder, tag, frontmatter `status`, filename date),
   then `VaultReader` reads only those files' relevant sections.
5. The tool returns a structured result (JSON) to `core`, which composes
   the reply deterministically (`core/respond.ts` — no model call for
   tasks/schedule/notes/memory intents; only `general` chit-chat calls
   Gemini, see §7's decision log).
6. `server` returns `{ reply, toolCalls }` to the browser, which renders
   the text and, if `ELEVENLABS_API_KEY`/`ELEVENLABS_VOICE_ID` are
   configured, calls `POST /api/tts` to speak it aloud.
7. `core` records relevant state (e.g. "last query: today's tasks") to
   `JARVIS/STATE/current-session.md` / `current-day.md`, and — only if the
   memory heuristic in `MEMORY.md` says so — writes a fact to
   `JARVIS/MEMORY/*.md`.

At no point is the full vault, or even a full note, sent to the model by
default — only the fields/sections the retrieval step selected.

## 4. Retrieval strategy (current: index + heuristic scoring, no vector DB)

See `JARVIS/MEMORY.md` for the memory-write side. On the read side:

1. **Classify intent** (`core/intent.ts`) — a small rule/keyword-based
   classifier (e.g. "tasks", "notes", "memory", "schedule", "general").
   No ML model call is needed for this step; it's cheap and deterministic.
   It can be swapped for a model-based classifier later without changing
   its interface.
2. **Determine candidate scope** from the intent (e.g. "tasks" → look in
   `Tasks/` and any file with `type: task` frontmatter or an unchecked
   `- [ ]` list; "schedule" → `Daily/<today>.md`).
3. **Query the index** (`JARVIS/INDEX/vault-index.json`) — a lightweight
   JSON built by `VaultIndexer` containing, per file: path, title, tags,
   frontmatter, outbound links, mtime. No note bodies are stored in the
   index.
4. **Score and shortlist** candidates (folder match, tag match, frontmatter
   match, recency, filename match).
5. **Read only the shortlisted files**, and only the relevant section
   (e.g. the `## Tasks` heading block) when the file is large.
6. **Build a minimal context object** and pass it to the tool or the
   model — never the raw file list.

This is deliberately simple (no embeddings) because the vault is expected
to be small-to-medium and well-organized (folders, tags, frontmatter).
Embedding-based semantic search is a documented future extension (see
`JARVIS/TOOLS.md` and §6 below) to add only if keyword/metadata retrieval
proves insufficient in practice — not preemptively.

## 5. Memory tiers

See `JARVIS/MEMORY.md` for the full design. Summary: session (in-process,
never persisted by default) → short-term (`JARVIS/STATE/current-day.md`,
rewritten daily) → permanent (`JARVIS/MEMORY/*.md`, append-only facts,
never auto-populated from every utterance).

## 6. Designed-for, not-yet-built extensions

The module boundaries above exist specifically so these can be added
later without a rewrite:
- Calendar, email, weather, web search tools (new files under `tools/`).
- Vector/semantic search as an additional retrieval strategy behind the
  same `retrieval.ts` interface.
- Multiple specialized sub-agents behind the same tool-router interface.
- A native desktop shell around the same `server/` + `public/` UI.
- Proactive daemon (cron-like) that runs intent-free heuristics (overdue
  tasks, day planning) and calls the same tools `core` uses.

## 7. Decisions (newest first)

- **2026-09-14** — Two more fixes, both from live testing on the redesigned
  screen:
  1. **General chit-chat replying only "Entendido, señor."** — the user
     saw this on a real question and had no way to tell why. Root cause
     wasn't new: `JarvisCore.composeReplyForIntent` already sends a
     `debugError` field with the real reason whenever the Gemini call
     fails (bad/expired key, quota, network) and it falls back to the
     templated reply, and `/api/chat` already includes it in the JSON
     response, and `JarvisApiClient.ChatReply` already parsed it — but
     `MainActivity`'s chat handler silently discarded it, so every
     Gemini failure was undiagnosable from the app. Now shown as a small
     centered note in the transcript (`addSystemNote`, matching the web
     UI's muted `.turn.tool` style) whenever `debugError` is non-null.
     This doesn't fix whatever is wrong with Gemini on the user's Render
     deployment (unknown until they see the actual note text) — it makes
     the *next* occurrence self-diagnosing instead of a mystery.
  2. **The full-width orb (see the entry below) took too much vertical
     space, crowding out the chat** — reverted to a fixed, centered box,
     smaller than before (260dp → 220dp) since the user specifically
     asked for more room for the conversation. Kept the denser
     particles/bigger `baseRadius` from the same round of tuning; only
     the container's screen-filling behavior was undone.
  This is the second time in a row an orb-sizing change needed a second
  pass after being seen live — there is no way to get this fully right
  without a real device in the loop, so treat any single tuning pass as
  provisional until the user confirms it, not as done.
- **2026-09-14** — Two follow-ups after the user saw the previous orb
  resize on a real phone and pointed out its corners weren't filled:
  (1) `activity_main.xml`'s orb container is now a full-width square (an
  `androidx.constraintlayout.widget.ConstraintLayout` wrapper with
  `layout_constraintDimensionRatio="1:1"` pinned to both screen edges),
  not a smaller 260dp box with background visible on either side — the
  `constraintlayout` dependency was already present, just unused before
  this. (2) `OrbView`'s `baseRadius` factor went from 0.34 to 0.38 so the
  particle sphere itself fills noticeably more of that square at rest;
  the documented trade-off is that the outermost ring can very briefly
  extend a few percent past the view's edge at maximum energy (Canvas
  just clips it silently, no error). The square's corners will always
  show background regardless of either change — a round sphere inscribed
  in a square frame geometrically cannot reach its corners, same as the
  web version; that part isn't a bug to fix, just how the shape works.
  Also added, requested in the same message: a "Comandos" button
  (separate from "Detalles", see the entry below) and, per a follow-up
  asking for volume control specifically, a "Volumen de la voz de
  JARVIS" `SeekBar` inside "Detalles" — a single `"jarvis_volume"`
  SharedPreferences key (0–100, default 80) read by both `MainActivity`
  (applied via `MediaPlayer.setVolume`) and `JarvisListenerService`
  (applied to its own `MediaPlayer` the same way, and to the on-device
  `TextToSpeech` filler phrases via a `Bundle` with
  `TextToSpeech.Engine.KEY_PARAM_VOLUME`) — one slider controls JARVIS's
  voice everywhere, not just the chat screen.
- **2026-09-14** — Made the Android orb (`OrbView.kt`) bigger and denser
  after the user reported it looked sparse/dim on a real phone: the
  container grew from 200dp to 260dp, each ring's particle count went up
  ~1.5x (60/75/85/95/45 → 90/112/128/142/68), particle size roughly
  doubled (floor 0.6→1.1, scale 1.1+e·1.4→1.9+e·2.1), ray/core alpha and
  the ray stroke width increased, and the per-frame trail-fade alpha was
  lowered (0.32→0.24 base) so brightness accumulates more before being
  wiped. These are tuning-pass numbers with no device profiling behind
  them — if a real phone shows dropped frames with ~540 particles/frame
  on the software-rendered buffer canvas, that's the first thing to dial
  back down, not the container size or feel.
- **2026-09-14** — Added two small additions to `MainActivity`'s UI, both
  requested directly: (1) a "Comandos" button, deliberately separate from
  "Detalles" — it opens a plain `AlertDialog` listing every voice command
  JARVIS understands (`COMMANDS_HELP_TEXT`, a hand-maintained reference,
  not a listing generated from `JarvisListenerService.kt`'s regexes —
  keep both in sync manually when a command changes); (2) inside
  "Detalles", a "Leer las respuestas de JARVIS en voz alta" switch
  (`speak_replies_enabled` in SharedPreferences, default on) that gates
  the automatic TTS playback after a *typed* chat reply. Deliberately
  scoped to the chat screen only — the background listener
  (`JarvisListenerService`) always speaks, since silencing it would
  defeat the point of a voice assistant that isn't being looked at.
- **2026-09-14** — Added an optional way for "abre X" (and every other
  app-launching command — WhatsApp, calls, YouTube, Maps) to open
  directly instead of through a tap-to-open notification, per the user's
  request ("que las apps que no necesiten de la noti se habran solas").
  The honest answer given to the user first: this was never really about
  *which app* — Android's background-activity-launch restriction (API
  29+) blocks a background `Service` from calling `startActivity()`
  regardless of the target app, which is why every one of these commands
  needed the notification-tap workaround in the first place (a tap always
  counts as a qualifying user action). The one documented exemption that
  doesn't need a full-screen intent (which only auto-launches while the
  screen is off/locked — useless here, since the whole point of this
  listener is working with the phone already unlocked) is holding the
  `SYSTEM_ALERT_WINDOW` ("Mostrar sobre otras apps") permission *and*
  actively maintaining a window of type `TYPE_APPLICATION_OVERLAY` — just
  holding the permission isn't sufficient. So `JarvisListenerService` now
  keeps one permanently invisible 1×1 overlay window up for its whole
  lifetime purely to satisfy that check
  (`addInvisibleOverlayIfPermitted`/`removeInvisibleOverlay`) — it draws
  nothing a user could ever see or interact with. `launchApp` tries
  `startActivity()` directly whenever that overlay is up, falling back to
  the existing `launchViaNotification` otherwise (permission never
  granted, a ROM blocks it, or the direct call throws for any reason) —
  every call site keeps two spoken-reply variants
  (`CommandParseResult.LaunchNow.directSpokenText` /
  `.notifiedSpokenText`) since what actually happened differs. The
  permission itself is optional and requested the same way as the
  battery-optimization exemption (`MainActivity.requestOverlayPermission`,
  a `Settings.ACTION_MANAGE_OVERLAY_PERMISSION` intent) — declining it, or
  a ROM not supporting the settings intent, just means every command
  keeps using the notification exactly as before. Known rough edge: since
  the overlay is only added in `onCreate`, granting the permission while
  the listener is already running doesn't take effect until the user
  stops and restarts it (a fresh `onCreate`) — flagged to the user rather
  than solved with more code, since it's a one-time setup step, not a
  recurring annoyance.
- **2026-09-14** — Gave the Android app the same visual design as the web
  UI: a native `OrbView.kt` custom `View` ports `app/public/orb.js`'s
  particle-sphere rendering (same ring math, rotation, drag-to-spin with
  inertia, energy-driven scale/brightness) to Android `Canvas`, and
  `activity_main.xml` was redesigned to mirror `index.html`/`styles.css`'s
  layout (topbar with status pills, the orb centered, a scrolling
  conversation with user/assistant bubbles, a pill-shaped input row, a
  collapsible "Detalles" panel for the server/password fields that used
  to always be visible). The "mensaje de prueba" single-reply box became
  a real, persistent chat transcript. The user was asked to choose
  between embedding the actual web page in a WebView (pixel-identical,
  but Android's WebView doesn't support the Web Speech API the web mic
  button needs) versus a native reimplementation (more work, no
  limitations, but a second copy of the design to keep in sync); they
  chose native. Implementation notes for whoever touches this next:
  - Android `Canvas` has no `globalCompositeOperation = "lighter"`
    equivalent on a `View`'s own canvas, so `OrbView` draws into its own
    offscreen `Bitmap`/`Canvas` every frame (needed anyway for the
    fade-trail effect, since a `View`'s `onDraw` canvas isn't guaranteed
    to retain the previous frame's pixels) and uses
    `PorterDuffXfermode(PorterDuff.Mode.ADD)` for the glow elements
    (rays, particles, core) — additive blending works reliably on a
    plain `Bitmap`-backed `Canvas` regardless of the view's hardware
    layer type, unlike blending directly against a hardware-accelerated
    view canvas.
  - The orb's energy is driven by two sources instead of one: a fixed
    gentle pulse while waiting for the server's reply ("thinking"), then
    real TTS waveform data via `android.media.audiofx.Visualizer`
    attached to the `MediaPlayer`'s audio session while it plays — the
    closest native equivalent to the web version's real
    `AnalyserNode`-driven energy. `Visualizer` needs `RECORD_AUDIO`
    (already granted for the background listener), and is wrapped in a
    try/catch since some ROMs restrict it — falls back to the orb's own
    baseline idle animation, never a crash.
  - Any future web design change (`app/public/orb.js`,
    `styles.css`) has no automatic effect on the Android app — this is a
    second, hand-maintained copy of the same visual language, not a
    shared component. Update both intentionally.
- **2026-09-14** — Added Google Maps commands: "cómo llego a X", "cómo
  llego de X a Y" (directions), and "busca X cerca" (nearby search) —
  `tryParseMapsCommand`/`launchDirections` in `JarvisListenerService.kt`.
  Opens Google Maps via its public, documented "Maps URLs" scheme
  (`google.com/maps/dir/?api=1&destination=...` /
  `.../search/?api=1&query=...`) — same reasoning as the YouTube/Spotify
  search deep links: a real, stable URL format the app is built to
  handle, not a guessed one. No new Android permission needed — when
  `origin` is omitted, Maps uses the device's current location itself via
  its own already-granted location permission, not JARVIS's. No spoken
  confirmation, same as opening any app or search page — nothing happens
  to anyone but the user. Explicitly does **not** read the travel time or
  the nearest result back out loud — the user asked about this
  specifically, and doing that needs Google's actual Directions/Places
  API, which (unlike Gemini/ElevenLabs so far) requires a billing account
  on file even though it has a generous free monthly quota. Given that
  extra friction, the user chose the free/no-API-key version for now;
  the spoken-answer version stays a designed-for-later option if they
  decide to set up a Google Cloud API key later.
- **2026-09-14** — Made contact name matching for WhatsApp/calls
  nickname-tolerant (`namesMatch`/`fuzzyContains` in
  `JarvisListenerService.kt`). Previously a spoken name only matched a
  contact if it was a literal substring of the saved display name in one
  direction (`displayName.contains(spokenName)`) — so "manda un mensaje a
  Juan" would find a contact saved as "Juanito" (superstring), but "manda
  un mensaje a Juanito" would *not* find a contact saved as plain "Juan"
  (the missing direction), per the user's report. Now checks containment
  both ways, against the full name and each of its words, so either
  direction of a suffix-style nickname ("Juan"/"Juanito", "Ana"/"Anita")
  matches, with a minimum-length guard so short names like "Ana" don't
  loosely match unrelated contacts. Deliberately did not add a hardcoded
  Spanish nickname dictionary (Pepe/José, Chuy/Jesús, ...) — those are too
  irregular to enumerate reliably, and the existing safety net already
  covers a wrong guess: the confirmation prompt always reads back the
  *actual* resolved contact name before sending/calling, so the user
  hears exactly who would receive the message and can say "no" if it
  matched the wrong person; an ambiguous case (multiple contacts fuzzy-
  matching) already asked the user to be more specific rather than
  guessing, unchanged by this fix.
- **2026-09-14** — Added conversational memory: (1) session memory now
  survives a process restart — persisted as JSON to
  `JARVIS/STATE/session-history.json` on every turn and reloaded in
  `JarvisCore.init`, so Render's free-tier cold starts (see § 6 below, and
  the `/healthz` decision) no longer wipe the conversation the user was
  just having; (2) "olvida X" now actually forgets, via a two-turn
  confirm-then-act flow in `JarvisCore.handleTextMessage` (a `pendingForget`
  slot held in memory across the two HTTP requests), mirroring the
  Android app's WhatsApp/call confirmation pattern for the same reason:
  `memory.forgetMemory` is a `"destructive"` tool and `JARVIS/SECURITY.md`
  requires explicit same-turn confirmation before any destructive tool
  runs. Deliberately kept the forget-target detection
  (`core/forgetCommand.ts`) as a check *before* intent classification,
  not inside it — running the target text through `shouldPersist` (the
  save heuristic) would risk re-saving it as a new fact just because it
  happens to mention a project/person/preference keyword (e.g. "olvida
  que tengo un proyecto con Juan" contains "proyecto"). Did not build a
  separate long-term "conversation log" beyond the existing session
  buffer (capped at 40 turns) — that already covers "remembers the
  conversation" for the cold-start case this was meant to fix, and
  permanent memory already exists for facts meant to outlive any single
  conversation.
- **2026-09-14** — Simplified "abre X" / "abre X y reproduce Y" to their
  literal forms only (dropped "ábreme"/"la app de X"/"busca"/"pon"
  synonyms), per the user's explicit request. Also found and fixed a real
  bug while debugging why "abre X y reproduce Y" reported "dijo algo pero
  no llegó ninguna notificación": `launchViaNotification` never checked
  whether notifications were actually enabled before calling `notify()`
  — which doesn't throw when they're off, it just silently shows
  nothing, so every command using it (WhatsApp, calls, YouTube, opening
  apps) could fail exactly as silently as the background-activity-start
  restriction it was built to work around. Now checks
  `NotificationManagerCompat.areNotificationsEnabled()` and the specific
  channel's importance first, speaking a clear diagnostic ("tiene las
  notificaciones de JARVIS desactivadas...") instead of posting nothing.
  `launchViaNotification` now returns whether it actually posted, and
  every call site only speaks its own success message when it did —
  otherwise the two `speakLocally` calls would race, with the second
  (queued with `QUEUE_FLUSH`) cutting off the diagnostic message.
- **2026-09-14** — Added compound "abre X y reproduce/busca Y" (e.g.
  "abre Disney reproduce deadpool"). Only opens X *and* searches inside
  it for a small allowlist of apps (`SEARCH_DEEP_LINKS`: currently
  YouTube, Spotify) that publish a real, documented search-by-title deep
  link — for any other app (Disney+, Netflix, ...), it opens the app
  plainly and tells the user it can't search there automatically, rather
  than guessing an unofficial URI scheme that could silently open the
  wrong screen or nothing at all. This mirrors the same reasoning as not
  auto-playing a specific YouTube video: only automate what's actually
  reliable, and say so plainly when something isn't rather than faking it.
- **2026-09-14** — Added two more on-device commands: "reproduce/busca X
  en YouTube" (opens YouTube's search-results page for X) and "abre X"
  (opens any installed app matched by name). Unlike WhatsApp/calls,
  neither requires a spoken confirmation — opening an app or a search
  page has no effect on anyone but the user themselves, per
  `JARVIS/SECURITY.md` § Android app actions' "no unnecessary
  confirmation" principle stated there for exactly this distinction. Both
  reuse `launchViaNotification` (same background-activity-start
  restriction as WhatsApp/calls applies to opening any app). Deliberately
  did *not* try to auto-play a specific YouTube video: doing that
  reliably needs YouTube's Data API (a key to manage, quota limits, and
  a real chance of "playing the wrong video" since search relevance is
  a judgment call) — opening real search results with visible
  thumbnails/titles for the user to pick from is more honest about what
  can actually be automated here. Finding installed apps by name needed
  a `<queries>` declaration in `AndroidManifest.xml` (Android 11+ hides
  other installed apps by default unless declared) — the sanctioned
  alternative to the heavily Play-Store-restricted `QUERY_ALL_PACKAGES`
  permission.
- **2026-09-14** — Fixed WhatsApp/calling silently doing nothing after a
  confirmed "sí" — JARVIS spoke "Listo, señor" but WhatsApp/the dialer
  never actually appeared, with no error surfaced. Root cause: Android
  (API 29+) silently blocks a background `Service` from calling
  `startActivity()` to launch another app — no exception is thrown, the
  launch is just dropped, so the code had no way to know it failed.
  Fixed by launching both via a tap-to-open notification instead
  (`launchViaNotification`, posted on a dedicated high-importance
  channel) — a notification tap always counts as a direct user action and
  is exempt from this restriction. Trade-off: confirming now requires one
  extra tap (on the notification) rather than the app opening
  automatically — an acceptable cost for it actually working, and
  consistent with WhatsApp itself already requiring a manual tap to send.
  Also switched `URLEncoder`'s `+`-for-space encoding to `%20` in the
  `wa.me` link (`+` is valid but some WhatsApp versions handle it
  inconsistently in query strings).
- **2026-09-14** — Fixed the WhatsApp/call confirmation always resolving
  to "no" regardless of what the user actually said, and added a "jarvis
  apágate" shutdown command. Root cause: `SpeechRecognizer` restarted
  listening immediately after speaking the confirmation prompt, so the
  phone's own mic picked up JARVIS's spoken question through the speaker
  as if it were the user's answer — which obviously never matches a
  yes/no, so every confirmation fell through to "Cancelado" no matter
  what was said afterward. Fixed with an `isSpeaking` flag that keeps the
  recognizer off for the duration of both on-device `TextToSpeech` (via
  `UtteranceProgressListener`'s `onDone`/`onError`) and ElevenLabs
  `MediaPlayer` playback (via `onCompletion`/`onError`), resuming only
  once JARVIS actually finishes talking. This bug affected any spoken
  reply, not just confirmations, but was only *visible* on confirmations
  since every other command tolerates a stray misheard utterance being
  silently ignored (no wake word in it), while a confirmation treats
  literally the next utterance as the answer. Also hardened confirmation
  matching to strip trailing punctuation (`"sí."` didn't equal `"si"`).
  Separately, added "jarvis apágate" (matches inside "oye jarvis apágate"
  too, no separate wake-word check needed) — stops the listener, clears
  the reboot-restart flag, and kills the app's own process outright, with
  no confirmation needed since — unlike WhatsApp/calls — it only affects
  the person saying it.
- **2026-09-14** — Added two on-device Android capabilities, both gated on
  an explicit spoken confirmation: "envíale un mensaje a X que diga Y"
  (opens WhatsApp with the message pre-filled) and "llama a X" (places a
  real phone call). See `JARVIS/SECURITY.md` § Android app actions for the
  full confirmation rules; key design points:
  - **Fully on-device, never through the JARVIS server or Gemini.** The
    user asked directly whether this could "steal" their data; the answer
    designed for is that it structurally can't for these two commands —
    command parsing (simple regex against the accent-stripped transcript),
    contact lookup (`ContactsContract`), and the confirmation
    readback/listen (Android's on-device `TextToSpeech` and
    `SpeechRecognizer`) all happen in `JarvisListenerService` with zero
    network calls. Only the wake word's *other* (non-messaging,
    non-calling) commands ever reach `/api/chat`.
  - **WhatsApp**: no direct-send API exists for third-party apps (WhatsApp
    removed it for spam prevention), so this opens `https://wa.me/<phone>
    ?text=<message>` (their own documented "click to chat" deep link) —
    the message arrives pre-filled, but the user must tap Send themselves
    inside WhatsApp. This is a platform restriction, not a JARVIS choice.
  - **Phone calls**: `Intent.ACTION_CALL` places the call immediately on
    confirmation (`CALL_PHONE` permission) — no platform restriction
    equivalent to WhatsApp's, so once the user says yes, it just happens.
  - **Contact resolution is a plain case/accent-insensitive substring
    match against `ContactsContract` display names** — no fuzzy matching,
    no relationship terms ("mi hermano" only works if a contact is
    literally saved under that name). Zero matches or multiple matches
    both abort with a spoken explanation rather than guessing.
  - **A shared `PendingConfirmation` sealed type and `CommandParseResult`**
    unify the two commands' confirm-then-act flow (parse → resolve
    contact → speak readback → wait up to `CONFIRMATION_WINDOW_MS` → act
    only on a recognized affirmative, anything else including a timeout is
    "no") rather than duplicating the state machine per command — the
    next such capability should extend these same two types.
  - **`READ_CONTACTS`/`CALL_PHONE` are requested up front** (batched with
    the mic/notification permissions when the listener is first activated)
    since a foreground `Service` cannot itself prompt for a runtime
    permission — but both are optional at that point: declining either
    still lets the background listener start, degrading gracefully to "no
    tengo permiso" only if that specific command is actually spoken later.
- **2026-09-14** — Added a public `GET /healthz` endpoint
  (`app/src/server/app.ts`, returns `{ok:true}`, no auth required) so an
  external uptime pinger can keep Render's free-tier service from
  spinning down after 15 minutes idle — the user reported exactly that
  symptom (usually fast, but sometimes a 30+ second delay) once the
  Android wake-word listener made it obvious how often the server was
  sitting idle between uses. Deliberately reveals nothing beyond "the
  process responded" — no vault data, no config, unlike `/api/status`.
  Recommended pinger: an external service (e.g. UptimeRobot's free tier,
  ~5 minute interval) rather than a GitHub Actions scheduled workflow —
  GitHub explicitly deprioritizes `schedule:` triggers on low-activity
  repos and can delay them by many minutes, which defeats the purpose
  when Render's spin-down window is only 15 minutes.
- **2026-09-14** — Added `BootReceiver` so the "oye jarvis" listener
  restarts itself after the phone reboots, if the user had it turned on —
  otherwise every reboot would silently defeat the point of a background
  listener, requiring the user to reopen the app and tap the toggle again
  each time. A `listener_enabled` flag in `SharedPreferences`, set/cleared
  by `MainActivity`'s toggle and also by `JarvisListenerService` itself
  when stopped via the notification's "Detener" action (so both stop
  paths stay in sync), is what `BootReceiver` checks on
  `BOOT_COMPLETED`. Same MIUI caveat as everywhere else in this
  sub-project: without the phone's separate "Inicio automático"
  (autostart) permission granted, MIUI won't even deliver the boot
  broadcast to the app, so this alone doesn't remove the need for that
  manual step.
- **2026-09-14** — Implemented milestone 2 of the Android companion app:
  the actual "oye jarvis" background wake-word listener
  (`android/app/src/main/java/com/jarvis/app/JarvisListenerService.kt`),
  a foreground service with `foregroundServiceType="microphone"`. Key
  choices:
  - **Continuous listening without a dedicated wake-word engine**: no
    Picovoice/Snowboy-style keyword spotter — just Android's built-in
    `SpeechRecognizer` in a restart-after-every-result loop (same pattern
    as the web UI's `SpeechRecognition` auto-restart), checking every
    transcript for "oye jarvis" (accent/case-insensitive via
    `java.text.Normalizer`) before sending anything to the server.
    Utterances without the wake word are discarded locally, never sent
    over the network — this matters both for privacy and so idle
    background chatter doesn't rack up Gemini/ElevenLabs usage.
    Simplicity over efficiency deliberately: a real keyword-spotter model
    would use less battery, but adds a new dependency/SDK account and
    much more that could go wrong on a build Claude can't test directly
    (see the milestone-1 entry below on why that risk is being minimized
    everywhere possible in this sub-project).
  - **Wake word alone vs. wake word + command in one breath**: saying
    just "oye jarvis" gets a local, offline acknowledgment ("Sí, señor,
    dígame.", via Android's built-in `TextToSpeech`, no network call) and
    opens an 8-second window where the next utterance — with or without
    repeating the wake word — is treated as the command. Saying the whole
    thing at once ("oye jarvis qué tengo hoy") also works, extracting
    whatever follows the wake word directly. Real replies always use
    ElevenLabs (matching the web UI and MainActivity's voice), falling
    back to the local TTS only if the network call fails, so the user at
    least hears something went wrong instead of silence.
  - **Reads its own session from SharedPreferences** rather than holding
    a reference to `MainActivity` — the service must keep running after
    the activity is destroyed, so it can't depend on activity state.
  - **Battery optimization exemption requested up front**: tapping
    "Activar escucha en segundo plano" first asks the user to exempt the
    app from battery optimization
    (`Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) before
    starting the service — necessary but likely not sufficient on MIUI,
    which has its own separate "autostart" toggle with no public API to
    request it; that has to be walked through manually with the user once
    this is confirmed working with the screen unlocked (their stated
    requirement), and is the most likely explanation if the listener
    "just stops" after a while with no error.
- **2026-09-13** — Started a native Android companion app (`android/`), at
  the user's request, for a voice command that works without manually
  opening the web app first. A PWA cannot listen in the background once
  closed — that's a browser/OS restriction, not something JARVIS can work
  around — so a real always-listening wake word needs a native app with a
  foreground service. Key decisions:
  - **This sandbox cannot build Android apps.** `dl.google.com` (where the
    Android SDK platform/build-tools live) is blocked by this
    environment's network egress allowlist — confirmed live (`gradle
    tasks` fails resolving the Android Gradle Plugin, immediately after
    successfully downloading the Gradle distribution itself from
    `services.gradle.org`, which is allowed). Building locally, even just
    to sanity-check, is not possible here.
  - **Workaround: GitHub Actions builds the APK instead**
    (`.github/workflows/android-build.yml`, triggered on any push touching
    `android/`) — GitHub's runners have unrestricted internet access and
    the Android SDK preinstalled. The resulting signed APK is published to
    a GitHub Release (tag `android-latest`, `--clobber`-replaced on every
    build — not a version history), not an Actions artifact: artifacts are
    served from Azure Blob Storage (`*.blob.core.windows.net`), which this
    same sandbox's network egress allowlist also blocks (confirmed live: a
    403 fetching the artifact download URL, right after the build itself
    succeeded) — release assets are served from GitHub's own domains,
    which the sandbox can reach. Fetched from there and handed to the user
    directly as a file, since they can't navigate the GitHub UI comfortably.
  - **A committed release keystore** (`android/jarvis-release.keystore`,
    password in `android/gradle.properties`) signs every build — debug and
    release alike — so a new APK always installs over the old one instead
    of requiring an uninstall first. Not treated as a real secret: this is
    a single-user, sideloaded app that's never published and never
    auto-updates itself, matching the risk posture already established for
    `JARVIS_APP_PASSWORD` (see `JARVIS/SECURITY.md` § Access control).
  - **Staged build-out, not one big leap**: since there's no way to test
    this app interactively before shipping it (no device/emulator
    available to Claude), milestone 1 is deliberately minimal — a login
    screen plus a "test message" button that exercises login, `/api/chat`,
    and `/api/tts` end to end — to validate the whole pipeline (GitHub
    Actions build → signed APK → sideload → talks to the real server)
    before adding the harder part (milestone 2: a foreground service doing
    continuous speech recognition for a wake word). The app reuses the
    exact same backend the web UI uses — no server-side changes were
    needed, since CORS doesn't apply to native HTTP clients. **Confirmed
    working live end to end on the user's phone**: login, a chat
    round-trip, and spoken playback of the reply all worked — the app's
    error-surfacing (added specifically because the first test had audio
    silently fail) correctly pinpointed the failure as the same
    `ELEVENLABS_VOICE_ID` Voice-Library restriction described below,
    which was a server config issue, not an app bug.
  - **Known risk flagged to the user up front**: the user's phone is
    Xiaomi/MIUI, which aggressively kills background services unless the
    user manually disables battery optimization and enables "autostart"
    for the app — this will need to be walked through once milestone 2
    (the background listener) exists, and is a likely source of "it just
    stopped working" reports that aren't actually bugs in the app.
- **2026-09-13** — Made JARVIS Spanish-only end to end, at the user's
  request. Previously the persona said "reply in whichever language the
  user is speaking" (a multilingual default); changed to "always reply in
  Spanish" in both `app/src/core/persona.ts` (Gemini's system prompt) and
  `JARVIS/PERSONA.md`. Also translated the remaining English strings in
  the UI itself (`app/public/index.html`, `app/public/app.js` — status
  pills, button labels, hint text, error messages) that had crept back to
  English during the app.js rewrite for the Gemini migration; the
  deterministic templates in `core/respond.ts` were already Spanish. This
  is a one-user, Spanish-speaking deployment, not a general-purpose
  multilingual assistant — don't reintroduce language-detection logic.
- **2026-09-13** — Made JARVIS installable as a PWA and gated the whole
  app behind an optional single shared password, at the user's request
  ("que sea una app en vez de una página para que solo yo la pueda
  utilizar"):
  - **PWA**: added `app/public/manifest.json`, a minimal
    `app/public/sw.js` (no offline caching — every JARVIS feature needs a
    live server, so caching responses would just serve stale data; the
    service worker exists purely to satisfy Chrome's installability
    check), and a purple orb-styled icon set (`app/public/icons/`).
    Registered from `app/public/app.js`. The result: "Add to Home Screen"
    on Android Chrome installs it with its own icon, opening full-screen
    with no browser address bar — no native build, no app store, no
    separate codebase to maintain. A future server-side change reaches
    the installed app on the next open, same as any web page, since
    there's no offline cache to go stale.
  - **Access control**: `JARVIS_APP_PASSWORD` (optional — unset keeps the
    app open as before, so existing deployments aren't broken) gates
    every page and API route except the login endpoint. Implemented as a
    stateless signed-cookie session (`app/src/server/auth.ts`) rather
    than a server-side session store, specifically so a login survives
    Render spinning the free-tier service down when idle. See
    `JARVIS/SECURITY.md` § Access control for the full design and
    rationale (single shared password, no accounts — matches this
    project's single-user scope).
- **2026-09-13** — Gave JARVIS an explicit personality: the classic
  British-butler archetype (the same one Tony Stark's JARVIS uses) —
  composed, formal but warm, dry wit, addresses the user as "señor".
  Previously the persona was competent but generic ("calm, professional,
  concise") with no distinctive voice. Updated both halves that must stay
  in sync (`JARVIS/PERSONA.md` and `app/src/core/persona.ts`'s system
  prompt for Gemini), and the deterministic templates in
  `core/respond.ts` (tasks/schedule/notes/memory replies never call a
  model, so they needed the personality baked in directly, not just the
  Gemini-backed "general" chit-chat path).
- **2026-09-13** — Switched `ELEVENLABS_VOICE_ID` away from a voice
  browsed from ElevenLabs' shared Voice Library, after live testing on
  Render surfaced `402 {"code":"paid_plan_required","message":"Free users
  cannot use library voices via the API. Please upgrade your subscription
  to use this voice."}` on every `POST /api/tts` call. ElevenLabs
  distinguishes "premade" voices bundled with every account (usable via
  the API on the Free plan) from "Voice Library" voices — community/shared
  voices a user can browse and add for use on the ElevenLabs *website*,
  but not through the API without a paid plan. See `app/.env.example` for
  a known-working premade voice id. Lesson: don't assume a voice id picked
  from ElevenLabs' UI works via the API just because it plays fine on
  their site — check whether it's a "premade" voice or a "library" one.
- **2026-09-13** — Replaced OpenAI entirely (Realtime API for voice, Chat
  Completions for general-intent text) with a three-part split, at the
  user's explicit request, after OpenAI's billing/credit setup became a
  blocker for testing:
  - **Speech input**: the browser's built-in Web Speech API
    (`SpeechRecognition`/`webkitSpeechRecognition`) instead of WebRTC to
    OpenAI Realtime. Free, needs no API key, works entirely client-side;
    the tradeoff is it only runs in Chromium-based browsers (Chrome/Edge)
    and requires an internet connection (the browser still calls Google's
    speech service under the hood), but that's an acceptable tradeoff for
    a personal tool. `continuous: true` with an `onend` auto-restart
    handler, since browsers stop listening after a silence gap even in
    continuous mode.
  - **General-intent text replies**: Google Gemini
    (`voice/geminiClient.ts`, `generateContent` REST endpoint,
    `GEMINI_MODEL` default `gemini-3.5-flash`) instead of OpenAI Chat
    Completions. Same scope as before — only the `general` intent calls
    it; tasks/schedule/notes/memory stay fully deterministic
    (`core/respond.ts`). Rationale: Gemini's free tier needs no credit
    card, unlike OpenAI's.
  - **Speech output**: ElevenLabs (`voice/elevenLabsClient.ts`, `POST
    /api/tts`) — re-added after having been removed earlier the same day
    (see the two entries below) once the user confirmed they wanted their
    previously-chosen custom voice back. There is no more OpenAI-provided
    voice to fall back to now that Realtime is gone entirely, so
    ElevenLabs is the only speech-output path; without it configured,
    replies are text-only.
  This removes `voice/realtimeClient.ts`, `voice/textCompletion.ts`,
  `voice/types.ts`, `tools/jsonSchema.ts` (the zod→JSON-Schema tool-schema
  converter, only ever used to describe tools to OpenAI Realtime), and
  `server/routes/realtime.ts`/the `/api/realtime/session` endpoint. Voice
  mode and text-chat mode now share the exact same `POST /api/chat` code
  path (`JarvisCore.handleTextMessage`) — there is no separate "realtime
  session" concept left; "voice mode" in the UI just means "also
  transcribe my mic and also speak the reply back."
- **2026-09-13** — Migrated to OpenAI's current Realtime API endpoints
  after live testing on Render (with real credentials, unblocked network)
  surfaced `404 Invalid URL (POST /v1/realtime/sessions)`. Confirmed via
  web search that OpenAI moved ephemeral-token minting from
  `/v1/realtime/sessions` to `/v1/realtime/client_secrets` (session config
  now nested under a `session: { type: "realtime", ... }` object; the
  response's client secret is a top-level `value`/`expires_at`, not
  nested under `client_secret`), and moved the browser's WebRTC SDP
  exchange from `/v1/realtime?model=...` to `/v1/realtime/calls` (no
  `?model=` — the model is already bound to the client secret). Updated
  `app/src/voice/realtimeClient.ts` and `app/public/app.js` accordingly.
  This project's own docs/comments elsewhere may still describe the old
  endpoints in passing — if voice breaks again with a 404, check OpenAI's
  current Realtime API docs before assuming it's a config problem, since
  this API surface has moved at least once already.
- **2026-09-13** — Removed the ElevenLabs speech-output integration
  (added and reverted the same day, see the two entries below) at the
  user's request. Voice mode is back to a single provider end-to-end:
  OpenAI Realtime handles listening, reasoning, tool-calling, *and*
  speech output via its own built-in voice. The text-chat fallback no
  longer speaks its replies at all (there is no more TTS path for it).
  `ELEVENLABS_API_KEY`/`ELEVENLABS_VOICE_ID` config, `voice/elevenLabsClient.ts`,
  and `server/routes/tts.ts` are gone; the orb's audio reactivity (below)
  now only listens to OpenAI's own Realtime audio track and the mic.
- **2026-09-13** — Redesigned `app/public/` around a purple, audio-reactive
  particle-sphere visual (`app/public/orb.js`, pure Canvas 2D, no
  dependencies) instead of a plain status/log page. Real amplitude from
  whatever JARVIS is currently speaking, via a Web Audio `AnalyserNode` on
  OpenAI's own Realtime audio track, drives the sphere's
  scale/brightness/rotation speed each frame — see the `driveOrb()` loop
  in `app/public/app.js`. The user's mic input contributes a smaller,
  secondary reaction so the sphere feels alive while listening too. Also
  supports drag-to-spin (pointer events on the canvas add manual rotation
  on top of the automatic spin, with inertia on release). Verified
  visually with headless Chromium (idle vs. simulated full-energy render,
  and a simulated drag) before shipping, since this can't be checked any
  other way in this environment.
- **2026-09-13** — The text-chat fallback's "general" intent (small talk,
  open-ended questions — not tasks/schedule/notes/memory, which stay
  deterministic) now calls a real Chat Completions model
  (`app/src/voice/textCompletion.ts`, model configurable via
  `JARVIS_TEXT_MODEL`) when `OPENAI_API_KEY` is set, instead of always
  returning the static "Entendido." template. Falls back to the template
  if no key is configured or the call fails — this keeps the "text mode
  works with zero API key" guarantee for tests and dependency-free runs
  (see `JARVIS/DEVELOPMENT.md` § Tests) while making the fallback UI
  actually converse when a key is available. Rationale: a plain greeting
  ("hola, ¿cómo estás?") getting "Entendido." back was the first thing a
  new user hit when testing without voice, and felt broken rather than
  intentionally simple.
- **2026-09-13** — Split speech input and output across two providers:
  OpenAI Realtime still handles listening (input audio transcription),
  reasoning, and tool-calling, but when `ELEVENLABS_API_KEY` +
  `ELEVENLABS_VOICE_ID` are configured, the Realtime session is created
  with `modalities: ["text"]` (no OpenAI-generated audio) and the browser
  sends the finished response text to `POST /api/tts`
  (`app/src/voice/elevenLabsClient.ts`) to synthesize speech with a
  specific ElevenLabs voice instead. Without ElevenLabs configured, the
  session falls back to OpenAI's own built-in voice as before — this is
  additive, not a replacement. Rationale: the user wants a specific,
  chosen voice identity for JARVIS, which OpenAI's Realtime preset voices
  don't provide. Both API keys are read only inside `app/src/voice/`.
- **2026-09-13** — Chose Node.js + TypeScript for the app, Express for
  the HTTP server, and the OpenAI Realtime API (WebRTC from the browser,
  ephemeral token minted server-side) for voice. Rationale: first-class
  Realtime API support, single language across indexer/tools/server,
  fastest path to a working voice loop. Revisit only if voice quality or
  latency requirements demand a native client.
- **2026-09-13** — No vector database in v1. Retrieval is index +
  metadata + keyword scoring (§4). Rationale: avoids infra dependency and
  premature complexity; the interface is designed to allow swapping in
  embeddings later (§6) if measured retrieval quality requires it.
- **2026-09-13** — The vault and the app live in the same repository, with
  `JARVIS/` holding the assistant's own docs/memory/state/index and
  `app/` holding all code. Rationale: matches the user's requirement that
  the project "live inside the Obsidian vault" while keeping code out of
  the user's content folders.
