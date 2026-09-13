# ARCHITECTURE.md

## 1. Overview

JARVIS is split into two halves that share a filesystem but not a runtime:

- **The vault** (this repo's root): plain Markdown data — the user's notes,
  the assistant's own memory, and its documentation. No code runs here; it
  is read and written by the app.
- **The app** (`app/`): a Node.js/TypeScript service that indexes the
  vault, holds the tool system and memory engine, talks to the OpenAI
  Realtime API for voice, and serves a small web UI.

```
┌──────────────────────────┐
│        User (voice)      │
└────────────┬─────────────┘
             │ mic audio (WebRTC, browser)
             ▼
┌──────────────────────────┐
│     Voice Interface       │   app/src/voice
│   OpenAI Realtime API     │   (session token minting + tool bridge)
└────────────┬─────────────┘
             │ transcript / tool-call events
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
- `voice/` — OpenAI Realtime session handling. Translates realtime
  tool-call events into calls against the tool registry and core; the core
  has no OpenAI-specific types.
- `server/` — HTTP endpoints (session token minting, text-chat fallback,
  status) and static file serving for `public/`.
- `logging/` — one structured logger used everywhere; never `console.log`
  directly in library code.

Dependency direction is strictly: `server → voice/core → memory|obsidian|tools`.
This means any of these pieces (e.g. swap OpenAI Realtime for another voice
provider, or swap the retrieval strategy for a vector index later) can be
replaced without touching the others.

## 3. Data flow: "JARVIS, ¿qué tengo hoy?"

1. Browser captures mic audio, streams it to OpenAI Realtime over WebRTC
   using a short-lived session token minted by `server/routes/realtime.ts`
   (the long-lived `OPENAI_API_KEY` never reaches the browser).
2. Realtime API transcribes speech and, per the session's tool
   definitions, emits a `tool_call` (e.g. `listTasks`, `searchNotes`)
   instead of hallucinating an answer.
3. `voice/RealtimeSession` receives the tool-call event and calls
   `core/toolRouter`, which validates params against the tool's schema and
   invokes the tool through `tools/registry.ts`.
4. The tool (e.g. `tasks/listTasks`) asks `obsidian/retrieval.ts` for the
   minimal context: it consults `JARVIS/INDEX/vault-index.json` to find
   candidate files (by folder, tag, frontmatter `status`, filename date),
   then `VaultReader` reads only those files' relevant sections.
5. The tool returns a structured result (JSON) to the realtime session,
   which feeds it back to the model as a tool result, never as raw
   instructions.
6. The model composes a spoken answer; audio streams back to the user.
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
