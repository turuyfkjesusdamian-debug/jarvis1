import { Router } from "express";
import { z } from "zod";
import type { JarvisCore } from "../../core/JarvisCore.js";

const bodySchema = z.object({ transcript: z.string().min(1) });

/**
 * Android-only: classifies a voice command that didn't match any of
 * JarvisListenerService's own deterministic phrasings into one of a small,
 * fixed set of on-device actions (or "none") — see JARVIS/ARCHITECTURE.md
 * § Decisions. The web UI never calls this; it has no on-device actions to
 * perform.
 */
export function deviceCommandRouter(core: JarvisCore): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Body must be { transcript: string }" });
      return;
    }
    const result = await core.classifyDeviceCommand(parsed.data.transcript);
    res.json(result);
  });

  return router;
}
