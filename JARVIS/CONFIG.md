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
| `OPENAI_API_KEY`       | yes (voice) | —             | Server-side only. Used to mint ephemeral Realtime session tokens. Never sent to the browser or logged. |
| `ELEVENLABS_API_KEY`   | no (speech) | —             | Server-side only. When set together with `ELEVENLABS_VOICE_ID`, JARVIS speaks via ElevenLabs instead of an OpenAI Realtime built-in voice. Never sent to the browser or logged. |
| `ELEVENLABS_VOICE_ID`  | no (speech) | —             | The ElevenLabs voice to speak with. Not a secret by itself, but only meaningful together with `ELEVENLABS_API_KEY`. |
| `JARVIS_VAULT_PATH`    | no       | repo root        | Absolute or relative path to the Obsidian vault root. Defaults to the repository root since the vault and app are co-located. |
| `JARVIS_LOG_LEVEL`     | no       | `info`           | One of `debug`, `info`, `warn`, `error`. |
| `JARVIS_ENV`           | no       | `development`    | One of `development`, `test`, `production`. Controls things like whether `.env` is required. |
| `JARVIS_PORT`          | no       | `3939`           | HTTP port for the local server (UI + API). Ignored if `PORT` is set. |
| `PORT`                 | no       | —                | Standard variable injected by hosting platforms (Render, Heroku, Railway, ...) to assign the port at deploy time. Takes priority over `JARVIS_PORT` when present — don't set this yourself locally. |
| `JARVIS_REALTIME_MODEL`| no       | `gpt-realtime`   | Model id passed to the Realtime API session. |
| `JARVIS_TEXT_MODEL`    | no       | `gpt-4o-mini`    | Chat Completions model used for the text-chat fallback's general-conversation replies only (see `JARVIS/ARCHITECTURE.md` § Decisions). Unused if `OPENAI_API_KEY` isn't set. |

## Rules

- Config is validated once at startup (`zod` schema in `app/src/config/index.ts`).
  A missing/invalid required variable fails fast with a clear error — the
  app never starts in a half-configured state.
- `OPENAI_API_KEY` is read only inside `app/src/voice/` and
  `app/src/server/routes/realtime.ts`. No other module should import it.
- `ELEVENLABS_API_KEY` is read only inside `app/src/voice/elevenLabsClient.ts`
  (via `requireElevenLabsConfig`). No other module should import it.
- Never add a new secret-like variable without updating `JARVIS/SECURITY.md`
  and `.gitignore` if it implies a new file.
- Tests never require `OPENAI_API_KEY` — anything that needs it is mocked
  (see `JARVIS/DEVELOPMENT.md` § Tests). `app/vitest.config.ts` forces
  `OPENAI_API_KEY`/`ELEVENLABS_API_KEY`/`ELEVENLABS_VOICE_ID` to empty for
  every test run regardless of what's in a developer's local `app/.env`,
  so the suite can't accidentally make a real network call with a real key.
