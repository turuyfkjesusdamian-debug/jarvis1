import { describe, it, expect, vi, afterEach } from "vitest";
import { generateConversationalReply } from "../../src/voice/geminiClient.js";
import type { JarvisConfig } from "../../src/config/index.js";

function makeConfig(overrides: Partial<JarvisConfig> = {}): JarvisConfig {
  return {
    geminiApiKey: "test-key-123",
    geminiModel: "gemini-3.5-flash",
    elevenLabsApiKey: undefined,
    elevenLabsVoiceId: undefined,
    vaultPath: "/tmp/vault",
    logLevel: "error",
    env: "test",
    port: 3939,
    appDir: "/tmp/app",
    ...overrides,
  };
}

describe("generateConversationalReply (Gemini)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the persona as systemInstruction, history + utterance as contents, and the key as a query param", async () => {
    let capturedUrl = "";
    let capturedBody: any = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedBody = JSON.parse(init.body as string);
        return {
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: "¡Muy bien! ¿Y tú?" }] } }],
          }),
        } as Response;
      })
    );

    const reply = await generateConversationalReply(
      makeConfig(),
      "You are JARVIS.",
      [{ role: "user", content: "hola" }, { role: "assistant", content: "hola, ¿en qué ayudo?" }],
      "hola cómo estás"
    );

    expect(capturedUrl).toContain("gemini-3.5-flash:generateContent");
    expect(capturedUrl).toContain("key=test-key-123");
    expect(capturedBody.systemInstruction).toEqual({ parts: [{ text: "You are JARVIS." }] });
    expect(capturedBody.contents.at(-1)).toEqual({ role: "user", parts: [{ text: "hola cómo estás" }] });
    // Prior assistant turns map to Gemini's "model" role, not "assistant".
    expect(capturedBody.contents.some((c: any) => c.role === "model")).toBe(true);
    expect(reply).toBe("¡Muy bien! ¿Y tú?");
  });

  it("throws when GEMINI_API_KEY is not configured", async () => {
    await expect(
      generateConversationalReply(makeConfig({ geminiApiKey: undefined }), "sys", [], "hola")
    ).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it("throws a clear error on a non-OK response, without leaking the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, text: async () => "bad request" } as Response)));
    const cfg = makeConfig();
    await expect(generateConversationalReply(cfg, "sys", [], "hola")).rejects.toThrow(/400/);
    try {
      await generateConversationalReply(cfg, "sys", [], "hola");
    } catch (err) {
      expect(String(err)).not.toContain(cfg.geminiApiKey);
    }
  });

  it("throws when the response has no text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ candidates: [] }) } as Response)));
    await expect(generateConversationalReply(makeConfig(), "sys", [], "hola")).rejects.toThrow(/no text/);
  });
});
