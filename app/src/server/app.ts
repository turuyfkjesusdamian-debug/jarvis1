import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import { getConfig } from "../config/index.js";
import { JarvisCore } from "../core/JarvisCore.js";
import { isValidSessionToken, parseCookies, SESSION_COOKIE_NAME } from "./auth.js";
import { authRouter } from "./routes/auth.js";
import { toolsRouter } from "./routes/tools.js";
import { chatRouter } from "./routes/chat.js";
import { deviceCommandRouter } from "./routes/deviceCommand.js";
import { statusRouter } from "./routes/status.js";
import { ttsRouter } from "./routes/tts.js";

const srcDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(srcDir, "..", "public");

// Reachable without a valid session: the login page itself, the endpoints
// it calls, PWA metadata a browser may fetch before a user is logged in,
// and the health check an external uptime pinger hits to stop Render's
// free tier from spinning the service down after 15 minutes idle (see
// JARVIS/ARCHITECTURE.md § Decisions) — it must be reachable without a
// password, since a pinger can't log in.
const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/auth/logout", "/login.html", "/manifest.json", "/sw.js", "/healthz"]);
function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || pathname.startsWith("/icons/");
}

export async function createApp(vaultPath: string): Promise<{ app: Express; core: JarvisCore }> {
  const core = new JarvisCore(vaultPath);
  await core.init();

  const app = express();
  app.use(express.json());

  // Deliberately reveals nothing beyond "the process is up" — an external
  // pinger (e.g. UptimeRobot) hits this every few minutes to keep Render's
  // free tier from spinning down, which is what caused the 30+ second
  // cold-start delays the user reported.
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // Single-user password gate (see JARVIS/SECURITY.md § Access control).
  // No-op when JARVIS_APP_PASSWORD isn't set, so existing deployments
  // aren't broken by upgrading.
  app.use((req, res, next) => {
    const cfg = getConfig();
    if (!cfg.appPassword || isPublicPath(req.path)) {
      next();
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    if (isValidSessionToken(cfg, cookies[SESSION_COOKIE_NAME])) {
      next();
      return;
    }
    if (req.path.startsWith("/api/")) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.sendFile(path.join(publicDir, "login.html"));
  });

  app.use(express.static(publicDir));

  app.use("/api/auth", authRouter());
  app.use("/api/tools", toolsRouter(core));
  app.use("/api/chat", chatRouter(core));
  app.use("/api/device-command", deviceCommandRouter(core));
  app.use("/api/status", statusRouter(core));
  app.use("/api/tts", ttsRouter());

  return { app, core };
}
