import { describe, it, expect, afterEach } from "vitest";
import { VaultReader, extractSection } from "../../src/obsidian/VaultReader.js";
import { createTempVault } from "../testUtils.js";

describe("VaultReader", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("reads frontmatter and content separately", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const reader = new VaultReader(vault.vaultPath);

    const result = await reader.readNote("Notes/onboarding.md");
    expect(result.frontmatter.title).toBe("Onboarding");
    expect(result.content).toContain("Onboarding");
  });

  it("writes a new note with frontmatter and reads it back", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const reader = new VaultReader(vault.vaultPath);

    await reader.writeNote("Notes/new-note.md", "# New note\n\nHello.", { title: "New note", tags: ["x"] });
    const result = await reader.readNote("Notes/new-note.md");
    expect(result.frontmatter.title).toBe("New note");
    expect(result.content).toContain("Hello.");
  });

  it("appends text without clobbering existing content", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const reader = new VaultReader(vault.vaultPath);

    await reader.appendToNote("Tasks/tasks.md", "- [ ] Appended task");
    const result = await reader.readNote("Tasks/tasks.md");
    expect(result.content).toContain("Buy groceries");
    expect(result.content).toContain("Appended task");
  });

  it("rejects paths that escape the vault root", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const reader = new VaultReader(vault.vaultPath);

    expect(() => reader.resolve("../../etc/passwd")).toThrow(/escapes vault root/);
  });

  it("exists() returns false for missing notes without throwing", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const reader = new VaultReader(vault.vaultPath);

    expect(await reader.exists("Notes/does-not-exist.md")).toBe(false);
  });
});

describe("extractSection", () => {
  const content = [
    "# Title",
    "",
    "## Goals",
    "- goal one",
    "- goal two",
    "",
    "## Notes",
    "- a note",
  ].join("\n");

  it("extracts a section up to the next heading of equal depth", () => {
    const section = extractSection(content, "Goals");
    expect(section).toContain("goal one");
    expect(section).toContain("goal two");
    expect(section).not.toContain("a note");
  });

  it("returns undefined for a heading that doesn't exist", () => {
    expect(extractSection(content, "Nope")).toBeUndefined();
  });

  it("is case-insensitive on the heading text", () => {
    expect(extractSection(content, "goals")).toContain("goal one");
  });
});
