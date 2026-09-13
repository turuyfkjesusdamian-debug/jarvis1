import { describe, it, expect, vi, afterEach } from "vitest";
import { generateConversationalReply } from "../../src/voice/textCompletion.js";
import type { JarvisConfig } from "../../src/config/index.js";

function makeConfig(overrides: Partial<JarvisConfig> = {}): JarvisConfig {
  return {
    openaiApiKey: "sk-test",
    vaultPath: "/tmp/vault",
    logLevel: "error",
    env: "test",
    port: 3939,
    realtimeModel: "gpt-realtime",
    textModel: "gpt-4o-mini",
    appDir: "/tmp/app",
    ...overrides,
  };
}

describe("generateConversationalReply", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the persona, history, and utterance, and returns the model's text", async () => {
    let capturedAuth = "";
    let capturedBody: any = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedAuth = (init.headers as Record<string, string>).Authorization;
        capturedBody = JSON.parse(init.body as string);
        return {
          ok: true,
          json: async () => ({ choices: [{ message: { content: "¡Muy bien! ¿Y tú?" } }] }),
        } as Response;
      })
    );

    const reply = await generateConversationalReply(
      makeConfig(),
      "You are JARVIS.",
      [{ role: "user", content: "hola" }, { role: "assistant", content: "hola, ¿en qué ayudo?" }],
      "hola cómo estás"
    );

    expect(capturedAuth).toBe("Bearer sk-test");
    expect(capturedBody.model).toBe("gpt-4o-mini");
    expect(capturedBody.messages[0]).toEqual({ role: "system", content: "You are JARVIS." });
    expect(capturedBody.messages.at(-1)).toEqual({ role: "user", content: "hola cómo estás" });
    expect(reply).toBe("¡Muy bien! ¿Y tú?");
  });

  it("throws when OPENAI_API_KEY is not configured", async () => {
    await expect(
      generateConversationalReply(makeConfig({ openaiApiKey: undefined }), "sys", [], "hola")
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("throws a clear error on a non-OK response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" } as Response)));
    await expect(generateConversationalReply(makeConfig(), "sys", [], "hola")).rejects.toThrow(/500/);
  });

  it("throws when the response has no content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ choices: [] }) } as Response)));
    await expect(generateConversationalReply(makeConfig(), "sys", [], "hola")).rejects.toThrow(/no content/);
  });
});
