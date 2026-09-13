import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Tool, ToolContext } from "../../src/tools/types.js";
import { VaultReader } from "../../src/obsidian/VaultReader.js";
import { MemoryEngine } from "../../src/memory/MemoryEngine.js";
import { createTempVault } from "../testUtils.js";

const echoTool: Tool<{ text: string }, { text: string }> = {
  name: "test.echo",
  description: "Echoes text back.",
  permission: "read",
  parametersSchema: z.object({ text: z.string() }),
  async run(params) {
    return { ok: true, data: { text: params.text } };
  },
};

const deleteTool: Tool<{ id: string }, { deleted: string }> = {
  name: "test.delete",
  description: "Pretends to delete something.",
  permission: "destructive",
  parametersSchema: z.object({ id: z.string() }),
  async run(params) {
    return { ok: true, data: { deleted: params.id } };
  },
};

const throwingTool: Tool<Record<string, never>, never> = {
  name: "test.throws",
  description: "Always throws.",
  permission: "read",
  parametersSchema: z.object({}),
  async run() {
    throw new Error("boom");
  },
};

describe("ToolRegistry", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  async function makeCtx(): Promise<ToolContext> {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const reader = new VaultReader(vault.vaultPath);
    return {
      vaultReader: reader,
      getIndex: async () => ({ generatedAt: new Date().toISOString(), vaultPath: vault.vaultPath, files: [] }),
      memory: new MemoryEngine(reader),
    };
  }

  it("rejects unknown tool names", async () => {
    const registry = new ToolRegistry();
    const result = await registry.invoke("nope", {}, await makeCtx());
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects invalid parameters before running the tool", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const result = await registry.invoke("test.echo", { text: 123 }, await makeCtx());
    expect(result.ok).toBe(false);
  });

  it("runs a valid read tool call", async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    const result = await registry.invoke("test.echo", { text: "hi" }, await makeCtx());
    expect(result).toEqual({ ok: true, data: { text: "hi" } });
  });

  it("blocks a destructive tool without confirmation", async () => {
    const registry = new ToolRegistry();
    registry.register(deleteTool);
    const ctx = await makeCtx();
    const result = await registry.invoke("test.delete", { id: "abc" }, ctx);
    expect(result.ok).toBe(false);
  });

  it("allows a destructive tool once confirmed", async () => {
    const registry = new ToolRegistry();
    registry.register(deleteTool);
    const ctx = await makeCtx();
    ctx.confirmed = true;
    const result = await registry.invoke("test.delete", { id: "abc" }, ctx);
    expect(result).toEqual({ ok: true, data: { deleted: "abc" } });
  });

  it("turns an unexpected thrown error into a structured failure", async () => {
    const registry = new ToolRegistry();
    registry.register(throwingTool);
    const result = await registry.invoke("test.throws", {}, await makeCtx());
    expect(result.ok).toBe(false);
  });

  it("refuses to register the same tool name twice", () => {
    const registry = new ToolRegistry();
    registry.register(echoTool);
    expect(() => registry.register(echoTool)).toThrow(/already registered/);
  });
});
