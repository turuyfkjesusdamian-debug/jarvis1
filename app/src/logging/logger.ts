import { getConfig } from "../config/index.js";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const SECRET_KEYS = new Set([
  "apikey",
  "api_key",
  "geminiapikey",
  "elevenlabsapikey",
  "jarvisapppassword",
  "password",
  "token",
  "authorization",
  "secret",
]);

/** Recursively strips likely-secret fields before anything is logged. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(val, depth + 1);
  }
  return out;
}

export interface LogFields {
  [key: string]: unknown;
}

function log(level: Level, message: string, fields?: LogFields): void {
  const configuredLevel = getConfig().logLevel;
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(fields ? (redact(fields) as LogFields) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const logger = {
  debug: (message: string, fields?: LogFields) => log("debug", message, fields),
  info: (message: string, fields?: LogFields) => log("info", message, fields),
  warn: (message: string, fields?: LogFields) => log("warn", message, fields),
  error: (message: string, fields?: LogFields) => log("error", message, fields),
};
