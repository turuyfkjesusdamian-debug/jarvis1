import { describe, it, expect, afterEach } from "vitest";
import { VaultReader } from "../../src/obsidian/VaultReader.js";
import { ShortTermMemory } from "../../src/memory/shortTermMemory.js";
import { createTempVault } from "../testUtils.js";

describe("ShortTermMemory", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("rotates a stale day file to today on ensureFresh", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const reader = new VaultReader(vault.vaultPath);
    // The fixture seeds current-day.md dated 2026-09-13; force it stale.
    await reader.writeNote(
      "JARVIS/STATE/current-day.md",
      "# Today\n\n## Goals\n\n- old goal\n\n## Notes\n\n- old note\n",
      { type: "state", scope: "day", date: "2000-01-01" }
    );

    const shortTerm = new ShortTermMemory(reader);
    const { goals, notes } = await shortTerm.read();
    expect(goals).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("adds goals and notes and reads them back", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const shortTerm = new ShortTermMemory(new VaultReader(vault.vaultPath));

    await shortTerm.addGoal("Finish the report");
    await shortTerm.addNote("Meeting moved to 5pm");

    const { goals, notes } = await shortTerm.read();
    expect(goals).toEqual(["Finish the report"]);
    expect(notes).toEqual(["Meeting moved to 5pm"]);
  });
});
