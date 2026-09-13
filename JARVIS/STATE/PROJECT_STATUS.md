---
type: state
scope: project-status
updated: 2026-09-13
---

# Project status

## Current state: v1 (text + voice-ready) working end to end

First development session, completed in full through Phase 10 (hardening),
plus same-day follow-ups: ElevenLabs speech output was added, then removed,
then re-added; the UI was redesigned around an audio-reactive, drag-to-spin
particle sphere; several text-mode bugs found via live user testing were
fixed; and — the latest change — OpenAI was removed entirely (billing
became a blocker for the user) in favor of a three-part split: the
browser's own Web Speech API for listening, Google Gemini for
general-intent text replies, and ElevenLabs for speech output (see
`JARVIS/ARCHITECTURE.md` § Decisions for the full rationale). 97/97 tests
pass (`cd app && npm test`), `npm run typecheck` and `npm run build` are
clean.

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
- **Memory engine** (`app/src/memory/`): session (volatile, in-process),
  short-term (`JARVIS/STATE/current-day.md`, date-based rotation),
  permanent (`JARVIS/MEMORY/*.md`, one bullet per fact) behind
  `MemoryEngine`, plus the `shouldPersist` heuristic (conservative:
  explicit "remember" > stable preference > project/people mention >
  nothing; skips questions so "¿qué recuerdas sobre el proyecto?" doesn't
  get saved as if it were a fact).
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
  `/api/{status,chat,tools,tts}`. `/api/tools/:name` requires
  `confirmed: true` in the body for destructive tools.
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
- **Tests** (`app/tests/`, 97 tests / 17 files): indexer, retrieval,
  reader (incl. path-traversal rejection), both memory tiers + the
  persistence heuristic (incl. the question-vs-statement fix), every tool
  group, the registry's validation/permission/confirmation logic, intent
  classification (incl. recall questions), an end-to-end `JarvisCore`
  flow (including a test that a note containing "ignore all previous
  instructions" is treated as inert data, per `JARVIS/SECURITY.md`, and
  tests for the conversational-reply path with/without a key and on
  failure), and the Gemini + ElevenLabs clients with `fetch` mocked (no
  network, no real API key needed — `vitest.config.ts` forces
  `GEMINI_API_KEY`/`ELEVENLABS_API_KEY`/`ELEVENLABS_VOICE_ID` empty for
  every test run regardless of the local `app/.env`).

## What's missing / next steps

- **Render's environment variables still need updating for this
  migration.** The deploy (`jarvis-12lx.onrender.com`) still has the old
  `OPENAI_API_KEY`/`JARVIS_REALTIME_MODEL`/`JARVIS_TEXT_MODEL` variables
  from the previous setup. They need to be replaced with `GEMINI_API_KEY`,
  `GEMINI_MODEL=gemini-3.5-flash` (`ELEVENLABS_API_KEY`/
  `ELEVENLABS_VOICE_ID` were already correct and can stay), then the
  service redeployed, before the user can test the new flow on their
  phone.
- **Gemini was live-verified working from this sandbox** (unlike OpenAI,
  `generativelanguage.googleapis.com` is not blocked by this sandbox's
  network egress allowlist) — real conversational replies confirmed via
  direct `curl` against a locally-run server. **ElevenLabs is still
  blocked in this sandbox** (`api.elevenlabs.io` — confirmed via a live
  403 "Host not in allowlist"), consistent with every prior finding; it
  must be verified on Render instead.
- **The browser Web Speech API voice loop has never been exercised with a
  real microphone in this session** — only the orb's visuals were checked
  with headless Chromium (screenshots, no console errors, no real speech
  recognition). The user needs to test the mic button on their actual
  phone/browser once Render's env vars are updated.
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
