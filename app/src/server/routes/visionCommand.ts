import { Router } from "express";
import { z } from "zod";
import type { JarvisCore } from "../../core/JarvisCore.js";

const bodySchema = z.object({
  transcript: z.string().min(1),
  image: z.string().min(1),
  task: z.enum(["describe", "locate"]),
});

/**
 * Android-only: answers a question about, or locates an element within, a
 * JPEG screenshot of the app's current screen — see JARVIS/ARCHITECTURE.md
 * § Decisions and JARVIS/SECURITY.md § Android app actions. Never used by
 * the web UI, which has no screen of its own to send.
 */
export function visionCommandRouter(core: JarvisCore): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Body must be { transcript, image, task }" });
      return;
    }
    const { transcript, image, task } = parsed.data;

    if (task === "describe") {
      try {
        const answer = await core.describeScreen(transcript, image);
        res.json({ answer });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    const located = await core.locateScreenElement(transcript, image);
    res.json(located);
  });

  return router;
}
