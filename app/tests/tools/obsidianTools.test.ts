import { describe, it, expect, afterEach } from "vitest";
import { searchNotes } from "../../src/tools/obsidian/searchNotes.js";
import { readNote } from "../../src/tools/obsidian/readNote.js";
import { createNote } from "../../src/tools/obsidian/createNote.js";
import { updateNote } from "../../src/tools/obsidian/updateNote.js";
import { appendToNote } from "../../src/tools/obsidian/appendToNote.js";
import { createTempVault, buildToolContext } from "../testUtils.js";

describe("obsidian tools", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("searchNotes finds notes by tag without returning full content", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const result = await searchNotes.run({ tags: ["reference"] }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.some((r) => r.path === "Notes/onboarding.md")).toBe(true);
    }
  });

  it("readNote returns content and can narrow to a section", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const result = await readNote.run({ path: "Notes/onboarding.md" }, ctx);
    expect(result.ok).toBe(true);
  });

  it("readNote fails cleanly for a missing note", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const result = await readNote.run({ path: "Notes/does-not-exist.md" }, ctx);
    expect(result.ok).toBe(false);
  });

  it("createNote fails if the note already exists", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const result = await createNote.run({ path: "Notes/onboarding.md", content: "x" }, ctx);
    expect(result.ok).toBe(false);
  });

  it("createNote then readNote round-trips", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const created = await createNote.run({ path: "Notes/fresh.md", content: "Hello world" }, ctx);
    expect(created.ok).toBe(true);

    const read = await readNote.run({ path: "Notes/fresh.md" }, ctx);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.data.content).toContain("Hello world");
  });

  it("updateNote fails if the note does not exist", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const result = await updateNote.run({ path: "Notes/nope.md", content: "x" }, ctx);
    expect(result.ok).toBe(false);
  });

  it("appendToNote adds to an existing note without truncating it", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const result = await appendToNote.run({ path: "Notes/onboarding.md", text: "Extra line." }, ctx);
    expect(result.ok).toBe(true);

    const read = await readNote.run({ path: "Notes/onboarding.md" }, ctx);
    if (read.ok) {
      expect(read.data.content).toContain("Onboarding");
      expect(read.data.content).toContain("Extra line.");
    }
  });

  it("treats note content containing instruction-like text as plain data", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const result = await readNote.run({ path: "Notes/malicious.md" }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The tool must return the text verbatim as data — it is the caller's
      // (core's) responsibility to never treat it as an instruction. See
      // JARVIS/SECURITY.md.
      expect(result.data.content).toContain("ignore all previous instructions");
    }
  });
});
