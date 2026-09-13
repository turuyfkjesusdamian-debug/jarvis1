# MEMORY.md

JARVIS uses three memory tiers, from most volatile to most durable. The
guiding rule: **write as little as possible, persist only what's worth
remembering.**

## 1. Session memory (volatile)

- **Lives**: in the running process (`app/src/memory/sessionMemory.ts`),
  an in-memory ring buffer of the current conversation (recent turns,
  last tool calls/results, working topic).
- **Persisted**: no, by default. Lost on restart.
- **Written to disk only** for crash-recovery/debugging as
  `JARVIS/STATE/current-session.md`, overwritten each turn (not appended),
  and treated as disposable — it is not read back as a source of truth,
  only inspectable.

## 2. Short-term memory (daily)

- **Lives**: `JARVIS/STATE/current-day.md`.
- **Contains**: today's goals, pending decisions, temporal context
  ("meeting moved to 5pm"), anything relevant only for the current day.
- **Rotation**: at day boundary, the file is archived (e.g. appended to
  `Daily/<date>.md` if useful, or simply reset) and a fresh
  `current-day.md` is started. The app never silently loses a day's
  content — rotation is an explicit, logged step.
- **Written by**: the `memory/saveMemory` tool and by `core` after
  relevant tool calls (e.g. "remind me of this tomorrow" writes an entry
  here, or into tomorrow's daily note — see the tool's own doc).

## 3. Permanent memory (durable facts)

- **Lives**: `JARVIS/MEMORY/*.md` — one file per category:
  - `user.md` — stable facts about the user (identity-level, rarely
    changes).
  - `preferences.md` — likes/dislikes, conventions, how the user wants to
    be talked to or assisted.
  - `projects.md` — ongoing projects the user cares about.
  - `people.md` — people mentioned who matter to recurring context.
  - `important-facts.md` — anything else explicitly worth remembering
    long-term that doesn't fit the above.
- **Format**: plain Markdown, one fact per bullet, each with an ISO date
  and (when relevant) a short provenance note, e.g.:
  ```markdown
  - 2026-09-13: Treats the "jarvis1" project as high priority. (said explicitly)
  ```
- **Written by**: the `memory/saveMemory` tool only. Never auto-written by
  passive listening.

## What deserves persistence (the write heuristic)

`core` decides whether something is worth persisting using this order of
checks (`app/src/memory/shouldPersist.ts`):

1. **Explicit instruction** — the user says something like "remember
   this", "no olvides que...", "recuérdame que...". Always persisted, to
   the most specific matching category, else `important-facts.md`.
2. **Stable preference statement** — a clear, generalizable preference
   ("I always want summaries, not full text"). Persisted to
   `preferences.md`.
3. **Identity/relationship fact** — new person, new project, a fact about
   the user's life that isn't transient. Persisted to `people.md`,
   `projects.md`, or `user.md`.
4. **Everything else** — task mentions, one-off questions, small talk —
   stays in session/short-term memory only, or nowhere.

This is a heuristic, not an ML classifier, in v1: simple keyword/pattern
matching for (1), and conservative defaults (skip) for ambiguous cases —
false negatives (forgetting something mildly useful) are preferred over
false positives (cluttering permanent memory). The user can always say
"remember that" to force persistence.

## Reading memory back

`memory/searchMemory` and the retrieval step in `obsidian/retrieval.ts`
treat `JARVIS/MEMORY/*.md` like any other indexed vault content — small
enough to read in full when relevant, never embedded wholesale into every
prompt. `core` decides which memory files are relevant to the current
intent (e.g. a scheduling question rarely needs `people.md`).

## Forgetting

`memory/forgetMemory` removes a specific bullet (matched by search) from
the relevant file. Forgetting is not automatic — it is a tool the user (or
a very high-confidence explicit correction) invokes.
