import { Router } from "express";
import type { JarvisCore } from "../../core/JarvisCore.js";

/**
 * Executes a tool call on behalf of the browser (used by the voice data
 * channel bridge and by the minimal UI's manual tool tester). Destructive
 * tools require `confirmed: true` in the body, which the client must only
 * send after showing the user an explicit confirmation — never inferred
 * from model output. See JARVIS/SECURITY.md.
 */
export function toolsRouter(core: JarvisCore): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(core.tools.describeForModel());
  });

  router.post("/:name", async (req, res) => {
    const { name } = req.params;
    const { params, confirmed } = req.body ?? {};
    const outcome = await core.getToolRouter().call({ name, params, confirmed: Boolean(confirmed) });
    res.json(outcome.result);
  });

  return router;
}
