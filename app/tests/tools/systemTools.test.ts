import { describe, it, expect, afterEach } from "vitest";
import { getCurrentTime } from "../../src/tools/system/getCurrentTime.js";
import { getSystemStatus } from "../../src/tools/system/getSystemStatus.js";
import { createTempVault, buildToolContext } from "../testUtils.js";

describe("system tools", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("getCurrentTime returns a well-formed date/time", async () => {
    const result = await getCurrentTime.run({}, {} as any);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("getSystemStatus reports index freshness and memory counts", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const result = await getSystemStatus.run({}, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.vaultIndex.fileCount).toBeGreaterThan(0);
      expect(result.data.memoryFactCounts["important-facts"]).toBe(1);
    }
  });
});
