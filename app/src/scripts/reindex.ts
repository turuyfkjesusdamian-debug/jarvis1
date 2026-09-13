import path from "node:path";
import { getConfig } from "../config/index.js";
import { VaultIndexer } from "../obsidian/VaultIndexer.js";
import { logger } from "../logging/logger.js";

async function main(): Promise<void> {
  const cfg = getConfig();
  const indexer = new VaultIndexer(cfg.vaultPath);
  const indexFilePath = path.join(cfg.vaultPath, "JARVIS/INDEX/vault-index.json");
  const index = await indexer.reindex(indexFilePath);
  logger.info("Reindex complete", { files: index.files.length, indexFilePath });
}

main().catch((err) => {
  logger.error("Reindex failed", { error: String(err) });
  process.exit(1);
});
