# CLAUDE.md

This repository is the JARVIS personal assistant vault + application.

**Start at `JARVIS/AGENTS.md`.** It is the index of rules and pointers for
working on this project (architecture, config, memory, tools, security,
development workflow, current status). Do not duplicate its content here —
read it first, then follow its pointers to the specific document you need.

Quick facts for orientation:
- `JARVIS/` — the assistant's brain: docs, config reference, memory, state, index.
- `app/` — the Node.js/TypeScript application (core, tools, memory engine,
  Obsidian indexer/retrieval, voice integration, minimal web UI).
- `Projects/`, `Tasks/`, `Notes/`, `Daily/`, `People/`, `Resources/` — the
  user's actual vault content (data, not code).
- Before modifying anything, read `JARVIS/STATE/PROJECT_STATUS.md` for the
  current state of the project.
