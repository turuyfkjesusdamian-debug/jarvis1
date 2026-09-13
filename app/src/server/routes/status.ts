import { Router } from "express";
import type { JarvisCore } from "../../core/JarvisCore.js";
import { getConfig } from "../../config/index.js";

/** Non-secret status endpoint for the UI's status panel. */
export function statusRouter(core: JarvisCore): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const cfg = getConfig();
    const outcome = await core.getToolRouter().call({ name: "system.getSystemStatus", params: {} });
    res.json({
      env: cfg.env,
      geminiConfigured: Boolean(cfg.geminiApiKey),
      geminiModel: cfg.geminiModel,
      speechSynthesisConfigured: Boolean(cfg.elevenLabsApiKey && cfg.elevenLabsVoiceId),
      vaultPath: cfg.vaultPath,
      system: outcome.result,
    });
  });

  return router;
}
