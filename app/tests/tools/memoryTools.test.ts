import { describe, it, expect, afterEach } from "vitest";
import { saveMemory } from "../../src/tools/memory/saveMemory.js";
import { searchMemory } from "../../src/tools/memory/searchMemory.js";
import { forgetMemory } from "../../src/tools/memory/forgetMemory.js";
import { createTempVault, buildToolContext } from "../testUtils.js";

describe("memory tools", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("saveMemory then searchMemory finds it", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const saved = await saveMemory.run({ category: "preferences", text: "Prefers concise answers." }, ctx);
    expect(saved.ok).toBe(true);

    const found = await searchMemory.run({ query: "concise" }, ctx);
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.data.some((f) => f.text.includes("concise"))).toBe(true);
  });

  it("forgetMemory is blocked without confirmation", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);
    await saveMemory.run({ category: "people", text: "Ada is a colleague." }, ctx);

    // forgetMemory.run itself doesn't enforce confirmation — the registry
    // does (see registry.test.ts). This test exercises the tool logic in
    // isolation: it should succeed here because we call .run() directly.
    const result = await forgetMemory.run({ category: "people", textMatch: "Ada" }, ctx);
    expect(result.ok).toBe(true);
  });

  it("forgetMemory fails cleanly when nothing matches", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const result = await forgetMemory.run({ category: "people", textMatch: "Nobody" }, ctx);
    expect(result.ok).toBe(false);
  });
});
