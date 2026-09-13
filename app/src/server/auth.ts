import crypto from "node:crypto";
import type { JarvisConfig } from "../config/index.js";

/** Single-user password gate. No accounts, no server-side session store —
 * a valid session is just a timestamp signed with JARVIS_APP_PASSWORD, so
 * it survives process restarts (e.g. Render spinning the service down and
 * back up) without forcing a re-login. */
export const SESSION_COOKIE_NAME = "jarvis_session";
export const SESSION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/** Constant-time check against JARVIS_APP_PASSWORD. Never log the candidate. */
export function checkPassword(cfg: JarvisConfig, candidate: string): boolean {
  if (!cfg.appPassword) return false;
  return timingSafeStringEqual(candidate, cfg.appPassword);
}

/** Issues a signed session token good for SESSION_MAX_AGE_MS. */
export function createSessionToken(cfg: JarvisConfig): string {
  if (!cfg.appPassword) {
    throw new Error("JARVIS_APP_PASSWORD is not set.");
  }
  const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
  return `${expiresAt}.${sign(String(expiresAt), cfg.appPassword)}`;
}

/** Verifies a session token: well-formed, unexpired, and correctly signed. */
export function isValidSessionToken(cfg: JarvisConfig, token: string | undefined): boolean {
  if (!cfg.appPassword || !token) return false;
  const [expiresAtRaw, signature] = token.split(".");
  if (!expiresAtRaw || !signature) return false;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  return timingSafeStringEqual(signature, sign(expiresAtRaw, cfg.appPassword));
}

/** Minimal Cookie-header parser — no cookie-parser dependency needed since
 * we only ever read one cookie back and set them via Express's own res.cookie(). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
