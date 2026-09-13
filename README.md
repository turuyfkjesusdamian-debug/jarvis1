# JARVIS

A personal voice assistant that lives inside an Obsidian vault: it listens
by voice, understands intent, calls explicit tools, retrieves only the
vault content it needs, and remembers what's worth remembering — without
ever dumping the whole vault into a model call.

- **Start here for how it's built**: [`JARVIS/AGENTS.md`](JARVIS/AGENTS.md)
  (architecture, memory, tools, security, and where to find everything
  else).
- **Start here to run it**: [`JARVIS/DEVELOPMENT.md`](JARVIS/DEVELOPMENT.md).
- **Current status**: [`JARVIS/STATE/PROJECT_STATUS.md`](JARVIS/STATE/PROJECT_STATUS.md).

## Layout

- `JARVIS/` — the assistant's own docs, config reference, memory, state,
  and vault index.
- `app/` — the Node.js/TypeScript application (core, tools, memory
  engine, Obsidian indexer/retrieval, voice integration, minimal web UI).
- `Projects/`, `Tasks/`, `Notes/`, `Daily/`, `People/`, `Resources/` — the
  user's own vault content.

## Quick start

```bash
cd app
npm install
cp .env.example .env   # add OPENAI_API_KEY to enable voice; optional otherwise
npm run dev
```

Open `http://localhost:3939`. Text chat works immediately; voice mode
requires `OPENAI_API_KEY`.
