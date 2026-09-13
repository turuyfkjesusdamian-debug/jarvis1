import { Router } from "express";
import { z } from "zod";
import { getConfig } from "../../config/index.js";
import { checkPassword, createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS } from "../auth.js";

const bodySchema = z.object({ password: z.string().min(1) });

/** Login/logout for the single shared JARVIS_APP_PASSWORD gate. */
export function authRouter(): Router {
  const router = Router();

  router.post("/login", (req, res) => {
    const cfg = getConfig();
    if (!cfg.appPassword) {
      res.status(400).json({ ok: false, error: "No password is configured for this app." });
      return;
    }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "Body must be { password: string }" });
      return;
    }
    if (!checkPassword(cfg, parsed.data.password)) {
      res.status(401).json({ ok: false, error: "Incorrect password." });
      return;
    }
    res.cookie(SESSION_COOKIE_NAME, createSessionToken(cfg), {
      httpOnly: true,
      sameSite: "lax",
      secure: cfg.env === "production",
      maxAge: SESSION_MAX_AGE_MS,
      path: "/",
    });
    res.json({ ok: true });
  });

  router.post("/logout", (req, res) => {
    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    res.json({ ok: true });
  });

  return router;
}
