import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VaultReader } from "../src/obsidian/VaultReader.js";
import { VaultIndexer } from "../src/obsidian/VaultIndexer.js";
import { MemoryEngine } from "../src/memory/MemoryEngine.js";
import type { ToolContext } from "../src/tools/types.js";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_VAULT = path.join(testsDir, "..", "fixtures", "vault");

/** Copies the fixtures vault into a fresh temp directory so tests can write freely. */
export async function createTempVault(): Promise<{ vaultPath: string; cleanup: () => Promise<void> }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-test-vault-"));
  await fs.cp(FIXTURES_VAULT, tmpDir, { recursive: true });
  return {
    vaultPath: tmpDir,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

/**
 * Builds a real (non-mocked) ToolContext against a vault path, rebuilding
 * the index fresh on every getIndex() call — fine for tests, where the
 * vault is small and correctness matters more than caching.
 */
export function buildToolContext(vaultPath: string): ToolContext {
  const vaultReader = new VaultReader(vaultPath);
  const indexer = new VaultIndexer(vaultPath);
  return {
    vaultReader,
    getIndex: () => indexer.buildIndex(),
    memory: new MemoryEngine(vaultReader),
  };
}
