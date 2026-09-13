import { Router } from "express";
import type { JarvisCore } from "../../core/JarvisCore.js";
import { getConfig } from "../../config/index.js";
import { createEphemeralRealtimeSession } from "../../voice/realtimeClient.js";
import { logger } from "../../logging/logger.js";

/**
 * Mints an ephemeral OpenAI Realtime session for the browser to connect
 * with directly over WebRTC. Requires OPENAI_API_KEY server-side; the
 * response never contains it. See JARVIS/SECURITY.md.
 */
export function realtimeRouter(core: JarvisCore): Router {
  const router = Router();

  router.post("/session", async (_req, res) => {
    try {
      const cfg = getConfig();
      const session = await createEphemeralRealtimeSession(cfg, core.tools);
      res.json(session);
    } catch (err) {
      logger.error("Realtime session route failed", { error: String(err) });
      res.status(503).json({ error: err instanceof Error ? err.message : "Unknown error" });
    }
  });

  return router;
}
