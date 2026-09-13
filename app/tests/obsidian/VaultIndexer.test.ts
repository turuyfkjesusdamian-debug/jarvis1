import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { VaultIndexer } from "../../src/obsidian/VaultIndexer.js";
import { createTempVault } from "../testUtils.js";

describe("VaultIndexer", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("indexes every markdown file with metadata but not full bodies", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;

    const indexer = new VaultIndexer(vault.vaultPath);
    const index = await indexer.buildIndex();

    const paths = index.files.map((f) => f.path).sort();
    expect(paths).toContain("Notes/onboarding.md");
    expect(paths).toContain("Tasks/tasks.md");
    expect(paths).toContain("Projects/project-apollo.md");

    const onboarding = index.files.find((f) => f.path === "Notes/onboarding.md");
    expect(onboarding?.title).toBe("Onboarding");
    expect(onboarding?.tags).toEqual(expect.arrayContaining(["reference", "jarvis"]));
    expect(onboarding?.links).toContain("Project Apollo");

    for (const file of index.files) {
      expect((file as any).content).toBeUndefined();
    }
  });

  it("excludes JARVIS/INDEX and JARVIS/LOGS from the scan", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;

    const indexer = new VaultIndexer(vault.vaultPath);
    const indexFilePath = path.join(vault.vaultPath, "JARVIS/INDEX/vault-index.json");
    await indexer.writeIndex(await indexer.buildIndex(), indexFilePath);

    const index = await indexer.buildIndex();
    expect(index.files.some((f) => f.path.startsWith("JARVIS/INDEX/"))).toBe(false);
  });

  it("reindex persists to disk and readIndex reads it back", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;

    const indexer = new VaultIndexer(vault.vaultPath);
    const indexFilePath = path.join(vault.vaultPath, "JARVIS/INDEX/vault-index.json");
    const written = await indexer.reindex(indexFilePath);
    const read = await indexer.readIndex(indexFilePath);

    expect(read?.files.length).toBe(written.files.length);
  });

  it("readIndex returns undefined when no index file exists", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const indexer = new VaultIndexer(vault.vaultPath);
    const result = await indexer.readIndex(path.join(vault.vaultPath, "nope.json"));
    expect(result).toBeUndefined();
  });
});
