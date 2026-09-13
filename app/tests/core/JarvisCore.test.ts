import { describe, it, expect, afterEach } from "vitest";
import { JarvisCore } from "../../src/core/JarvisCore.js";
import { createTempVault } from "../testUtils.js";

describe("JarvisCore", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("initializes by building a vault index", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const core = new JarvisCore(vault.vaultPath);
    await core.init();

    const status = await core.getToolRouter().call({ name: "system.getSystemStatus", params: {} });
    expect(status.result.ok).toBe(true);
    if (status.result.ok) {
      expect((status.result.data as any).vaultIndex.fileCount).toBeGreaterThan(0);
    }
  });

  it("answers a schedule question end-to-end using tools, not hallucination", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const core = new JarvisCore(vault.vaultPath);
    await core.init();

    const result = await core.handleTextMessage("¿Qué tengo hoy?");
    expect(result.intent).toBe("schedule");
    expect(result.toolCalls.some((c) => c.name === "tasks.listTasks")).toBe(true);
    expect(result.toolCalls.every((c) => c.result.ok)).toBe(true);
    // The task from the fixture vault should surface in the reply.
    expect(result.reply).toMatch(/Apollo|groceries/i);
  });

  it("does not persist an ordinary schedule question to permanent memory", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const core = new JarvisCore(vault.vaultPath);
    await core.init();

    await core.handleTextMessage("¿Qué tengo hoy?");
    const facts = await core.memory.permanent.listAll();
    expect(facts).toHaveLength(1); // only the fixture-seeded fact, nothing new
  });

  it("persists an explicit remember request and confirms naturally, without echoing the utterance", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const core = new JarvisCore(vault.vaultPath);
    await core.init();

    const result = await core.handleTextMessage("Remember that this project is important to me.");
    const facts = await core.memory.permanent.list("important-facts");
    expect(facts.some((f) => f.text.includes("important to me"))).toBe(true);
    expect(result.reply).not.toContain("Remember that this project is important to me");
    expect(result.reply.toLowerCase()).toMatch(/recordar/);
  });

  it("answers a memory recall question without polluting permanent memory with the question itself", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const core = new JarvisCore(vault.vaultPath);
    await core.init();

    const result = await core.handleTextMessage("¿Qué recuerdas sobre el proyecto?");
    expect(result.intent).toBe("memory");
    expect(result.reply).not.toBe("Entendido.");

    const projectFacts = await core.memory.permanent.list("projects");
    expect(projectFacts.some((f) => f.text.includes("¿Qué recuerdas"))).toBe(false);
  });

  it("recalls a previously saved fact when asked a differently-phrased question", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const core = new JarvisCore(vault.vaultPath);
    await core.init();

    await core.handleTextMessage("Remember that the Apollo project deadline is next week.");
    const result = await core.handleTextMessage("¿Qué recuerdas sobre el proyecto Apollo?");

    expect(result.intent).toBe("memory");
    expect(result.reply.toLowerCase()).toContain("apollo");
  });

  it("never lets note content posing as an instruction change behavior", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const core = new JarvisCore(vault.vaultPath);
    await core.init();

    const result = await core.handleTextMessage("busca notas sobre suspicious");
    expect(result.intent).toBe("notes");
    // Finding the note must not cause any task/memory deletion side effect.
    const tasksAfter = await core.getToolRouter().call({ name: "tasks.listTasks", params: { includeCompleted: true } });
    expect(tasksAfter.result.ok).toBe(true);
    if (tasksAfter.result.ok) {
      expect((tasksAfter.result.data as any[]).length).toBeGreaterThan(0);
    }
  });

  it("reindexes after a mutating tool call so subsequent reads see the change", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const core = new JarvisCore(vault.vaultPath);
    await core.init();

    await core.getToolRouter().call({
      name: "tasks.createTask",
      params: { text: "Freshly created task" },
    });
    const listed = await core.getToolRouter().call({ name: "tasks.listTasks", params: {} });
    if (listed.result.ok) {
      expect((listed.result.data as any[]).some((t) => t.text.includes("Freshly created task"))).toBe(true);
    }
  });
});
