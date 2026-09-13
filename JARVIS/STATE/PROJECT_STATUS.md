---
type: state
scope: project-status
updated: 2026-09-13
---

# Project status

## Current state: v1 (text + voice-ready) working end to end

First development session, completed in full through Phase 10 (hardening),
plus same-day follow-ups: ElevenLabs speech output was added, then removed
again at the user's request (single-provider voice again — see
`JARVIS/ARCHITECTURE.md` § Decisions); the UI was redesigned around an
audio-reactive, drag-to-spin particle sphere; and several text-mode bugs
found via live user testing were fixed. 100/100 tests pass
(`cd app && npm test`), `npm run typecheck` and `npm run build` are clean.

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
  reply (`core/respond.ts`, no model call); "general" chit-chat calls a
  real Chat Completions model (`voice/textCompletion.ts`,
  `JARVIS_TEXT_MODEL`) when `OPENAI_API_KEY` is set, falling back to the
  template if not configured or the call fails.
- **Voice** (`app/src/voice/`): `createEphemeralRealtimeSession` mints a
  short-lived OpenAI Realtime token server-side (the long-lived
  `OPENAI_API_KEY` never leaves this function); tool schemas are
  auto-derived from the tool registry via a small zod→JSON-Schema
  converter (`tools/jsonSchema.ts`). Single provider end-to-end: OpenAI
  Realtime handles listening, reasoning, tool-calling, and its own
  built-in voice for speech output (no ElevenLabs — tried and reverted
  same day, see `JARVIS/ARCHITECTURE.md` § Decisions).
- **Server** (`app/src/server/`): Express app serving the static UI plus
  `/api/{status,chat,tools,realtime/session}`. `/api/tools/:name`
  requires `confirmed: true` in the body for destructive tools.
- **UI** (`app/public/`): a purple, audio-reactive particle sphere
  (`orb.js`, pure Canvas 2D, no dependencies) as the visual centerpiece —
  real amplitude from OpenAI's Realtime audio track (plus a lighter
  reaction to the mic) drives its scale/brightness/spin speed, and it can
  be dragged/flicked to spin manually with inertia. Conversation, tool
  activity, errors, and config are tucked into a collapsible panel so the
  sphere stays the focus. Text-chat fallback works without any API key
  (no speech output in this mode); voice mode is the WebRTC flow through
  `/api/realtime/session` and `/api/tools/:name`.
- **Tests** (`app/tests/`, 100 tests / 18 files): indexer, retrieval,
  reader (incl. path-traversal rejection), both memory tiers + the
  persistence heuristic (incl. the question-vs-statement fix), every tool
  group, the registry's validation/permission/confirmation logic, intent
  classification (incl. recall questions), an end-to-end `JarvisCore`
  flow (including a test that a note containing "ignore all previous
  instructions" is treated as inert data, per `JARVIS/SECURITY.md`, and
  tests for the conversational-reply path with/without a key and on
  failure), and the realtime + text-completion clients with `fetch`
  mocked (no network, no real API key needed — `vitest.config.ts` forces
  `OPENAI_API_KEY` empty for every test run regardless of the local
  `app/.env`).

## What's missing / next steps

- **Not tested against the live OpenAI Realtime API or a real
  microphone/browser from this sandbox** — its network egress allowlist
  blocks `api.openai.com` (confirmed live: "Host not in allowlist",
  unrelated to the key itself). The user has deployed to Render
  (`jarvis-12lx.onrender.com`) to test with real network access instead;
  as of this writing they were mid-way through getting environment
  variables configured there (see the deploy's "Environment" tab — must
  include at least `OPENAI_API_KEY`, `JARVIS_VAULT_PATH=..`,
  `JARVIS_ENV=production`). The UI/orb changes were verified visually
  with headless Chromium in this sandbox (screenshots, no console
  errors) since that's the only check available here — real
  microphone + live Realtime audio still needs verification on a real
  device.
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
ElevenLabs add-then-revert, the orb UI).

## How to resume

1. Read `JARVIS/AGENTS.md`, then this file.
2. `cd app && npm install && npm test && npm run typecheck` — should be
   green before you change anything.
3. `cp app/.env.example app/.env` and fill in `OPENAI_API_KEY` to exercise
   voice; text-mode (`npm run dev`, then open the UI or `POST /api/chat`)
   works with no key at all.
4. Whatever you build, update the relevant `JARVIS/*.md` doc and this
   file — see `JARVIS/DEVELOPMENT.md` § "Adding a feature — checklist".
