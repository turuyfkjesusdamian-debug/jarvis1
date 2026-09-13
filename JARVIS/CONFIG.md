# CONFIG.md

All configuration is centralized in `app/src/config/index.ts`, loaded from
environment variables (via `.env` in `app/`, never committed). See
`app/.env.example` for the authoritative list with comments.

## Precedence

1. Real process environment variables (e.g. set by the OS/shell/CI).
2. `app/.env` (loaded with `dotenv`, only if present — not required in test
   mode, where everything is mocked).
3. Hardcoded defaults in `app/src/config/index.ts` (only for non-secret,
   safe-to-default values like log level or port).

There is no fourth layer. Nothing is ever read from the vault for secrets.

## Variables

| Variable              | Required | Default          | Purpose |
|------------------------|----------|------------------|---------|
| `GEMINI_API_KEY`       | no (general chit-chat only) | — | Server-side only. Used for the "general" intent's conversational replies (Google Gemini `generateContent`). Never sent to the browser or logged. Everything else (tasks/schedule/notes/memory, and speech-to-text) works without it. |
| `GEMINI_MODEL`         | no       | `gemini-3.5-flash` | Gemini model id used for general-intent replies. Unused if `GEMINI_API_KEY` isn't set. |
| `ELEVENLABS_API_KEY`   | no (voice output only) | — | Server-side only. Used to synthesize speech for replies via `POST /api/tts`. Never sent to the browser or logged. |
| `ELEVENLABS_VOICE_ID`  | no (voice output only) | — | ElevenLabs voice id to speak replies with. Required together with `ELEVENLABS_API_KEY` — both or neither. Must be a voice already in the account (a default "premade" voice, or one added/cloned by the account owner) — a voice merely browsed from ElevenLabs' shared Voice Library returns `402 paid_plan_required` via the API on the Free plan (found live in production — see `JARVIS/ARCHITECTURE.md` § Decisions). |
| `JARVIS_APP_PASSWORD`  | no       | —                | Gates the entire app behind this single shared password — see `JARVIS/SECURITY.md` § Access control. Unset means the app stays open to anyone with the link, as before. |
| `JARVIS_VAULT_PATH`    | no       | repo root        | Absolute or relative path to the Obsidian vault root. Defaults to the repository root since the vault and app are co-located. |
| `JARVIS_LOG_LEVEL`     | no       | `info`           | One of `debug`, `info`, `warn`, `error`. |
| `JARVIS_ENV`           | no       | `development`    | One of `development`, `test`, `production`. Controls things like whether `.env` is required. |
| `JARVIS_PORT`          | no       | `3939`           | HTTP port for the local server (UI + API). Ignored if `PORT` is set. |
| `PORT`                 | no       | —                | Standard variable injected by hosting platforms (Render, Heroku, Railway, ...) to assign the port at deploy time. Takes priority over `JARVIS_PORT` when present — don't set this yourself locally. |

Speech-to-text (the microphone) needs no server-side key at all: it runs
entirely in the browser via the Web Speech API (`SpeechRecognition`), which
requires a Chromium-based browser (Chrome/Edge) but no credentials.

## Rules

- Config is validated once at startup (`zod` schema in `app/src/config/index.ts`).
  A missing/invalid required variable fails fast with a clear error — the
  app never starts in a half-configured state.
- `GEMINI_API_KEY` is read only inside `app/src/voice/geminiClient.ts`.
  `ELEVENLABS_API_KEY` is read only inside `app/src/voice/elevenLabsClient.ts`
  and `app/src/server/routes/tts.ts`. `JARVIS_APP_PASSWORD` is read only
  inside `app/src/server/auth.ts` and `app/src/server/routes/auth.ts`. No
  other module should import them.
- Never add a new secret-like variable without updating `JARVIS/SECURITY.md`
  and `.gitignore` if it implies a new file.
- Tests never require `GEMINI_API_KEY` or `ELEVENLABS_API_KEY` — anything
  that needs them is mocked (see `JARVIS/DEVELOPMENT.md` § Tests).
  `app/vitest.config.ts` forces `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`,
  `ELEVENLABS_VOICE_ID`, and `JARVIS_APP_PASSWORD` to empty for every test
  run regardless of what's in a developer's local `app/.env`, so the suite
  can't accidentally make a real network call with a real key or gate
  itself behind a real password.
