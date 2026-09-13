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
  `/api/status`) and static file serving for `public/`.
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
