import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

// This file lives at <appDir>/src/config/index.ts (source) or
// <appDir>/dist/config/index.js (built) — either way, two levels up from
// its own directory is the app root.
const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Load app/.env if present. Never required (tests run without it).
dotenv.config({ path: path.join(appDir, ".env"), quiet: true });

const envSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  // See JARVIS/ARCHITECTURE.md § Decisions for why this default (chosen
  // 2026-09-13; check ai.google.dev/gemini-api/docs/models if it's ever
  // deprecated and this stops working).
  GEMINI_MODEL: z.string().default("gemini-3.5-flash"),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  // When set, gates the entire app behind a single shared password (see
  // JARVIS/SECURITY.md § Access control). Unset means the app stays open,
  // as before — this is opt-in so existing deployments don't break.
  JARVIS_APP_PASSWORD: z.string().optional(),
  JARVIS_VAULT_PATH: z.string().default(".."),
  JARVIS_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  JARVIS_ENV: z.enum(["development", "test", "production"]).default("development"),
  JARVIS_PORT: z.coerce.number().int().positive().optional(),
  // Standard variable injected by most hosting platforms (Render, Heroku,
  // Railway, ...) to say which port the app must bind to. Takes priority
  // over JARVIS_PORT when present — see getConfig() below.
  PORT: z.coerce.number().int().positive().optional(),
});

export type JarvisConfig = {
  geminiApiKey: string | undefined;
  geminiModel: string;
  elevenLabsApiKey: string | undefined;
  elevenLabsVoiceId: string | undefined;
  appPassword: string | undefined;
  vaultPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  env: "development" | "test" | "production";
  port: number;
  appDir: string;
};

function load(): JarvisConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const env = parsed.data;
  return {
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    elevenLabsApiKey: env.ELEVENLABS_API_KEY,
    elevenLabsVoiceId: env.ELEVENLABS_VOICE_ID,
    appPassword: env.JARVIS_APP_PASSWORD,
    vaultPath: path.resolve(appDir, env.JARVIS_VAULT_PATH),
    logLevel: env.JARVIS_LOG_LEVEL,
    env: env.JARVIS_ENV,
    port: env.PORT ?? env.JARVIS_PORT ?? 3939,
    appDir,
  };
}

let cached: JarvisConfig | undefined;

/** Loads and validates configuration once per process (cached). */
export function getConfig(): JarvisConfig {
  if (!cached) cached = load();
  return cached;
}

/** Test-only: force a config reload after mutating process.env. */
export function resetConfigForTests(): void {
  cached = undefined;
}

/** Fails fast if the conversational brain is used without Gemini configured. */
export function requireGeminiConfig(cfg: JarvisConfig): { apiKey: string; model: string } {
  if (!cfg.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not set. Conversational replies require it — see JARVIS/CONFIG.md.");
  }
  return { apiKey: cfg.geminiApiKey, model: cfg.geminiModel };
}

/** Fails fast if speech synthesis is used without ElevenLabs configured. */
export function requireElevenLabsConfig(cfg: JarvisConfig): { apiKey: string; voiceId: string } {
  if (!cfg.elevenLabsApiKey) {
    throw new Error("ELEVENLABS_API_KEY is not set. Speech synthesis requires it — see JARVIS/CONFIG.md.");
  }
  if (!cfg.elevenLabsVoiceId) {
    throw new Error("ELEVENLABS_VOICE_ID is not set. Speech synthesis requires it — see JARVIS/CONFIG.md.");
  }
  return { apiKey: cfg.elevenLabsApiKey, voiceId: cfg.elevenLabsVoiceId };
}
