import { Router } from "express";
import { z } from "zod";
import { getConfig } from "../../config/index.js";
import { synthesizeSpeech } from "../../voice/elevenLabsClient.js";
import { logger } from "../../logging/logger.js";

const bodySchema = z.object({ text: z.string().min(1).max(4000) });

/**
 * Text-to-speech endpoint backing both the realtime voice bridge (JARVIS
 * speaks via ElevenLabs instead of OpenAI's built-in Realtime voices) and
 * the text-chat fallback UI. See JARVIS/ARCHITECTURE.md § Decisions.
 */
export function ttsRouter(): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Body must be { text: string }" });
      return;
    }
    try {
      const audio = await synthesizeSpeech(getConfig(), parsed.data.text);
      res.setHeader("Content-Type", "audio/mpeg");
      res.send(audio);
    } catch (err) {
      logger.error("TTS route failed", { error: String(err) });
      res.status(503).json({ error: err instanceof Error ? err.message : "Unknown error" });
    }
  });

  return router;
}
