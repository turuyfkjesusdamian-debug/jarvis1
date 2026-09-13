import { describe, it, expect, afterEach } from "vitest";
import { VaultReader } from "../../src/obsidian/VaultReader.js";
import { PermanentMemory } from "../../src/memory/permanentMemory.js";
import { createTempVault } from "../testUtils.js";

describe("PermanentMemory", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("saves a fact to a new category file", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const memory = new PermanentMemory(new VaultReader(vault.vaultPath));

    await memory.save({ category: "user", date: "2026-09-13", text: "Likes tea." });
    const facts = await memory.list("user");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.text).toBe("Likes tea.");
  });

  it("appends to an existing category file without dropping prior facts", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const memory = new PermanentMemory(new VaultReader(vault.vaultPath));

    const before = await memory.list("important-facts");
    expect(before).toHaveLength(1); // seeded in the fixture vault

    await memory.save({ category: "important-facts", date: "2026-09-13", text: "New fact." });
    const after = await memory.list("important-facts");
    expect(after).toHaveLength(2);
  });

  it("search finds facts by substring across categories", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const memory = new PermanentMemory(new VaultReader(vault.vaultPath));

    await memory.save({ category: "projects", date: "2026-09-13", text: "The Apollo launch is in March." });
    const results = await memory.search("apollo");
    expect(results.some((f) => f.text.includes("Apollo"))).toBe(true);
  });

  it("forget removes a matching fact and preserves the rest", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const memory = new PermanentMemory(new VaultReader(vault.vaultPath));

    await memory.save({ category: "people", date: "2026-09-13", text: "Ada is a colleague." });
    await memory.save({ category: "people", date: "2026-09-13", text: "Grace is a friend." });

    const removed = await memory.forget("people", "Ada");
    expect(removed).toBe(true);

    const remaining = await memory.list("people");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.text).toContain("Grace");
  });

  it("forget returns false when nothing matches", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const memory = new PermanentMemory(new VaultReader(vault.vaultPath));

    expect(await memory.forget("people", "Nobody")).toBe(false);
  });
});
