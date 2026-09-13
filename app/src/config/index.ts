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
  OPENAI_API_KEY: z.string().optional(),
  JARVIS_VAULT_PATH: z.string().default(".."),
  JARVIS_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  JARVIS_ENV: z.enum(["development", "test", "production"]).default("development"),
  JARVIS_PORT: z.coerce.number().int().positive().default(3939),
  JARVIS_REALTIME_MODEL: z.string().default("gpt-realtime"),
});

export type JarvisConfig = {
  openaiApiKey: string | undefined;
  vaultPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  env: "development" | "test" | "production";
  port: number;
  realtimeModel: string;
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
    openaiApiKey: env.OPENAI_API_KEY,
    vaultPath: path.resolve(appDir, env.JARVIS_VAULT_PATH),
    logLevel: env.JARVIS_LOG_LEVEL,
    env: env.JARVIS_ENV,
    port: env.JARVIS_PORT,
    realtimeModel: env.JARVIS_REALTIME_MODEL,
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

/** Fails fast if voice features are used without a key configured. */
export function requireOpenAiKey(cfg: JarvisConfig): string {
  if (!cfg.openaiApiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Voice features require it — see JARVIS/CONFIG.md."
    );
  }
  return cfg.openaiApiKey;
}
