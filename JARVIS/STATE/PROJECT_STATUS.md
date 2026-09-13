---
type: state
scope: project-status
updated: 2026-09-13
---

# Project status

## Current state: v1 (text + voice-ready) working end to end

First development session, completed in full through Phase 10 (hardening),
plus a same-session follow-up adding ElevenLabs speech output. 89/89 tests
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
  nothing).
- **Tools** (`app/src/tools/`): full set from `JARVIS/TOOLS.md` —
  `obsidian.{searchNotes,readNote,createNote,updateNote,appendToNote}`,
  `tasks.{listTasks,createTask,completeTask,updateTask}`,
  `memory.{searchMemory,saveMemory,forgetMemory}`,
  `system.{getCurrentTime,getSystemStatus}`. Schema-validated (zod),
  permission-gated (`read`/`write`/`destructive`), logged, structured
  results — see `ToolRegistry.invoke`.
- **Core** (`app/src/core/`): `classifyIntent` (deterministic keyword
  classifier), `ToolRouter` (executes calls, logs to session memory +
  `JARVIS/STATE/last-actions.md`, reindexes the vault after any
  write/destructive call so subsequent reads aren't stale), `JarvisCore`
  facade, and a template-based `composeReply` for the text-mode fallback
  (no model call required — see below).
- **Voice** (`app/src/voice/`): `createEphemeralRealtimeSession` mints a
  short-lived OpenAI Realtime token server-side (the long-lived
  `OPENAI_API_KEY` never leaves this function); tool schemas are
  auto-derived from the tool registry via a small zod→JSON-Schema
  converter (`tools/jsonSchema.ts`). When `ELEVENLABS_API_KEY` +
  `ELEVENLABS_VOICE_ID` are both set, the session is created text-only
  (`modalities: ["text"]`) and `elevenLabsClient.ts` synthesizes the
  spoken reply instead of an OpenAI built-in voice — see
  `JARVIS/ARCHITECTURE.md` § Decisions.
- **Server** (`app/src/server/`): Express app serving the static UI plus
  `/api/{status,chat,tools,realtime/session,tts}`. `/api/tools/:name`
  requires `confirmed: true` in the body for destructive tools; `/api/tts`
  proxies text to ElevenLabs and returns audio bytes only (never the key).
- **UI** (`app/public/`): single-page status/conversation/tool-activity
  view, a text-chat fallback (works without any API key, and speaks its
  replies via `/api/tts` when ElevenLabs is configured), and browser-side
  WebRTC voice wiring (mic capture → OpenAI Realtime → tool-call bridge
  back through `/api/tools/:name`, with `/api/tts` used for output speech
  in the ElevenLabs case).
- **Tests** (`app/tests/`, 89 tests / 19 files): indexer, retrieval,
  reader (incl. path-traversal rejection), both memory tiers + the
  persistence heuristic, every tool group, the registry's
  validation/permission/confirmation logic, intent classification, an
  end-to-end `JarvisCore` flow (including a test that a note containing
  "ignore all previous instructions" is treated as inert data, per
  `JARVIS/SECURITY.md`), and the OpenAI + ElevenLabs clients with `fetch`
  mocked (no network, no real API keys needed).

## What's missing / next steps

- **Not tested against the live OpenAI Realtime API, ElevenLabs API, or a
  real microphone/browser** — this sandbox's network egress allowlist
  blocks both `api.openai.com` and `api.elevenlabs.io` (confirmed live:
  both return "Host not in allowlist" from this environment, unrelated to
  the keys themselves). Both the WebRTC flow in `app/public/app.js` and
  the ElevenLabs TTS call in `app/src/voice/elevenLabsClient.ts` follow
  the documented API contracts and are covered by tests with `fetch`
  mocked, but neither has been exercised against the real APIs. Whoever
  runs this with real keys and unrestricted network access (a local
  machine, or an environment allowlisting those hosts) should be the
  first to validate the voice + speech loop end-to-end and report back.
  Real-looking `OPENAI_API_KEY` (`sk-proj-...`) and `ELEVENLABS_API_KEY`
  (`sk_...`) plus `ELEVENLABS_VOICE_ID=aZilAbZ5tl8i9lA1EF02` are already
  in `app/.env` (local only, gitignored, never committed).
- Model-generated (non-templated) replies for the text-mode fallback are
  out of scope for v1 — see `core/respond.ts` for why the deterministic
  templates are a deliberate choice, not a stopgap forgotten in place.
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
(stack choice, no-vector-DB-in-v1, vault+app co-location).

## How to resume

1. Read `JARVIS/AGENTS.md`, then this file.
2. `cd app && npm install && npm test && npm run typecheck` — should be
   green before you change anything.
3. `cp app/.env.example app/.env` and fill in `OPENAI_API_KEY` to exercise
   voice; text-mode (`npm run dev`, then open the UI or `POST /api/chat`)
   works with no key at all.
4. Whatever you build, update the relevant `JARVIS/*.md` doc and this
   file — see `JARVIS/DEVELOPMENT.md` § "Adding a feature — checklist".
