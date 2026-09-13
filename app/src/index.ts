import { getConfig } from "./config/index.js";
import { logger } from "./logging/logger.js";
import { createApp } from "./server/app.js";

async function main(): Promise<void> {
  const cfg = getConfig();
  const { app } = await createApp(cfg.vaultPath);

  app.listen(cfg.port, () => {
    logger.info("JARVIS server listening", { port: cfg.port, env: cfg.env, geminiConfigured: Boolean(cfg.geminiApiKey) });
  });
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: String(err) });
  process.exit(1);
});
