# DEVELOPMENT.md

## Requirements

- Node.js 20+ (developed against Node 22).
- No external services required to develop or test — OpenAI is mocked in
  tests, and a fixtures vault (`app/fixtures/vault/`) stands in for a real
  Obsidian vault.

## Setup

```bash
cd app
npm install
cp .env.example .env   # then fill in OPENAI_API_KEY for voice features
```

## Running

```bash
cd app
npm run dev      # starts the server with the TypeScript source (tsx watch)
```

Open `http://localhost:3939` (or `$JARVIS_PORT`). The UI works in
text-chat mode without any API key; voice mode requires `OPENAI_API_KEY`.

Build/run compiled:
```bash
npm run build
npm start
```

## Rebuilding the vault index

The index is generated, not hand-maintained:
```bash
npm run index
```
This scans `JARVIS_VAULT_PATH` (defaults to the repo root) and writes
`JARVIS/INDEX/vault-index.json`. It also runs automatically on server
startup and can be triggered via the `system.getSystemStatus` /
reindex path (see `JARVIS/TOOLS.md`).

## Tests

```bash
cd app
npm test          # vitest, runs once
npm run test:watch
```

- No real API key or real vault is needed. `app/fixtures/vault/` is a
  small self-contained vault used by indexer/retrieval/memory tests.
- OpenAI Realtime calls are mocked at the module boundary
  (`app/tests/**/__mocks__`) — no network access in tests.
- Every new tool must have a test that checks: schema rejects bad input,
  `run` returns a structured result for a valid case, and (if
  destructive) that it refuses to run without confirmation.

## Typechecking / linting

```bash
npm run typecheck
```

## Adding a feature — checklist

1. Read `JARVIS/AGENTS.md` and the specific doc for the area you're
   touching.
2. Check `JARVIS/STATE/PROJECT_STATUS.md` for current state / known
   issues before assuming something doesn't exist yet.
3. Implement, following the module boundaries in `JARVIS/ARCHITECTURE.md`.
4. Add/update tests.
5. `npm run typecheck && npm test`.
6. Update the relevant doc(s) — don't let docs drift from code.
7. Update `JARVIS/STATE/PROJECT_STATUS.md` if the change is significant.

## Project layout

```
app/
├── src/
│   ├── config/     # env loading + validation
│   ├── core/       # orchestration: intent, context, persona, tool router
│   ├── memory/     # session / short-term / permanent memory
│   ├── obsidian/   # indexer, reader, retrieval
│   ├── tools/      # obsidian/, tasks/, memory/, system/ tool groups + registry
│   ├── voice/      # OpenAI Realtime integration
│   ├── logging/    # structured logger
│   └── server/     # Express app + routes + static UI serving
├── public/         # minimal web UI (status, conversation, text fallback)
├── tests/          # vitest, mirrors src/ layout
└── fixtures/vault/ # small vault used by tests
```
