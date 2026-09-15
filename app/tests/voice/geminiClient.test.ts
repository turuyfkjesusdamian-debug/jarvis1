import { describe, it, expect, vi, afterEach } from "vitest";
import { generateConversationalReply, classifyDeviceCommand } from "../../src/voice/geminiClient.js";
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

describe("classifyDeviceCommand (Gemini)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns none without a configured API key, without making a request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await classifyDeviceCommand(makeConfig({ geminiApiKey: undefined }), "reproduce boys don't cry");
    expect(result).toEqual({ action: "none" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("parses a play_media classification from the motivating example", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"action":"play_media","query":"boys don\'t cry"}' }] } }],
        }),
      } as Response))
    );
    const result = await classifyDeviceCommand(makeConfig(), "reproduce boys don't cry");
    expect(result).toEqual({ action: "play_media", query: "boys don't cry" });
  });

  it("parses a directions classification with an optional origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"action":"directions","destination":"el aeropuerto"}' }] } }],
        }),
      } as Response))
    );
    const result = await classifyDeviceCommand(makeConfig(), "llévame al aeropuerto");
    expect(result).toEqual({ action: "directions", destination: "el aeropuerto", origin: undefined });
  });

  it("falls back to none on malformed JSON instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: "not json at all" }] } }] }),
      } as Response))
    );
    const result = await classifyDeviceCommand(makeConfig(), "cualquier cosa");
    expect(result).toEqual({ action: "none" });
  });

  it("falls back to none on an action with a missing required field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '{"action":"open_app"}' }] } }] }),
      } as Response))
    );
    const result = await classifyDeviceCommand(makeConfig(), "abre no sé qué");
    expect(result).toEqual({ action: "none" });
  });

  it("falls back to none on a non-OK response instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" } as Response)));
    const result = await classifyDeviceCommand(makeConfig(), "algo");
    expect(result).toEqual({ action: "none" });
  });

  it("never classifies a WhatsApp/call-shaped request as an action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '{"action":"none"}' }] } }] }),
      } as Response))
    );
    const result = await classifyDeviceCommand(makeConfig(), "envíale un mensaje a mamá que diga hola");
    expect(result).toEqual({ action: "none" });
  });
});
