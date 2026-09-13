import { Router } from "express";
import { z } from "zod";
import type { JarvisCore } from "../../core/JarvisCore.js";

const bodySchema = z.object({ message: z.string().min(1) });

/** Text-mode fallback chat endpoint — usable without voice or an API key. */
export function chatRouter(core: JarvisCore): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Body must be { message: string }" });
      return;
    }
    const result = await core.handleTextMessage(parsed.data.message);
    res.json(result);
  });

  return router;
}
