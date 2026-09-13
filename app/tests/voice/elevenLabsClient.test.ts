import { describe, it, expect, vi, afterEach } from "vitest";
import { synthesizeSpeech } from "../../src/voice/elevenLabsClient.js";
import type { JarvisConfig } from "../../src/config/index.js";

function makeConfig(overrides: Partial<JarvisConfig> = {}): JarvisConfig {
  return {
    geminiApiKey: undefined,
    geminiModel: "gemini-3.5-flash",
    elevenLabsApiKey: "sk_test_key",
    elevenLabsVoiceId: "voice-123",
    vaultPath: "/tmp/vault",
    logLevel: "error",
    env: "test",
    port: 3939,
    appDir: "/tmp/app",
    ...overrides,
  };
}

describe("synthesizeSpeech", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the API key only in the xi-api-key header, targets the configured voice, and returns audio bytes", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedHeaders = init.headers as Record<string, string>;
        capturedBody = JSON.parse(init.body as string);
        return {
          ok: true,
          arrayBuffer: async () => new TextEncoder().encode("fake-mp3-bytes").buffer,
        } as Response;
      })
    );

    const audio = await synthesizeSpeech(makeConfig(), "Hola, JARVIS aquí.");

    expect(capturedUrl).toContain("voice-123");
    expect(capturedHeaders["xi-api-key"]).toBe("sk_test_key");
    expect(capturedBody.text).toBe("Hola, JARVIS aquí.");
    expect(Buffer.isBuffer(audio)).toBe(true);
    expect(audio.length).toBeGreaterThan(0);
  });

  it("throws when ELEVENLABS_API_KEY is missing", async () => {
    await expect(synthesizeSpeech(makeConfig({ elevenLabsApiKey: undefined }), "hi")).rejects.toThrow(
      /ELEVENLABS_API_KEY/
    );
  });

  it("throws when ELEVENLABS_VOICE_ID is missing", async () => {
    await expect(synthesizeSpeech(makeConfig({ elevenLabsVoiceId: undefined }), "hi")).rejects.toThrow(
      /ELEVENLABS_VOICE_ID/
    );
  });

  it("surfaces a clear error on a non-OK response and never leaks the key in it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, text: async () => "unauthorized" } as Response))
    );
    const cfg = makeConfig();
    await expect(synthesizeSpeech(cfg, "hi")).rejects.toThrow(/401/);
    try {
      await synthesizeSpeech(cfg, "hi");
    } catch (err) {
      expect(String(err)).not.toContain(cfg.elevenLabsApiKey);
    }
  });
});
