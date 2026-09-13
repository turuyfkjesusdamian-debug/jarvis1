import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getConfig, resetConfigForTests, requireGeminiConfig, requireElevenLabsConfig } from "../../src/config/index.js";

const ORIGINAL_ENV = { ...process.env };

describe("config", () => {
  beforeEach(() => {
    resetConfigForTests();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetConfigForTests();
  });

  it("applies safe defaults when nothing is set", () => {
    delete process.env.JARVIS_LOG_LEVEL;
    delete process.env.JARVIS_PORT;
    delete process.env.PORT;
    delete process.env.JARVIS_ENV;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL;

    const cfg = getConfig();
    expect(cfg.logLevel).toBe("info");
    expect(cfg.env).toBe("development");
    expect(cfg.port).toBe(3939);
    expect(cfg.geminiModel).toBe("gemini-3.5-flash");
    expect(cfg.geminiApiKey).toBeUndefined();
  });

  it("uses JARVIS_PORT when PORT is not set", () => {
    delete process.env.PORT;
    process.env.JARVIS_PORT = "4000";
    expect(getConfig().port).toBe(4000);
  });

  it("prefers the platform-injected PORT over JARVIS_PORT", () => {
    process.env.JARVIS_PORT = "4000";
    process.env.PORT = "10000";
    expect(getConfig().port).toBe(10000);
  });

  it("never requires GEMINI_API_KEY to load", () => {
    delete process.env.GEMINI_API_KEY;
    expect(() => getConfig()).not.toThrow();
  });

  it("throws a clear error for an invalid enum value", () => {
    process.env.JARVIS_LOG_LEVEL = "not-a-level";
    expect(() => getConfig()).toThrow(/Invalid configuration/);
  });

  it("requireGeminiConfig throws when the key is missing", () => {
    delete process.env.GEMINI_API_KEY;
    const cfg = getConfig();
    expect(() => requireGeminiConfig(cfg)).toThrow(/GEMINI_API_KEY/);
  });

  it("requireGeminiConfig returns the key and model when present", () => {
    process.env.GEMINI_API_KEY = "test-key-123";
    process.env.GEMINI_MODEL = "gemini-test";
    const cfg = getConfig();
    expect(requireGeminiConfig(cfg)).toEqual({ apiKey: "test-key-123", model: "gemini-test" });
  });

  it("resolves JARVIS_VAULT_PATH relative to the app directory", () => {
    process.env.JARVIS_VAULT_PATH = "./some-vault";
    const cfg = getConfig();
    expect(cfg.vaultPath.endsWith("some-vault")).toBe(true);
    expect(cfg.vaultPath).not.toContain("..");
  });

  it("requireElevenLabsConfig throws when either the key or voice id is missing", () => {
    delete process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_VOICE_ID;
    expect(() => requireElevenLabsConfig(getConfig())).toThrow(/ELEVENLABS_API_KEY/);

    resetConfigForTests();
    process.env.ELEVENLABS_API_KEY = "sk_test";
    delete process.env.ELEVENLABS_VOICE_ID;
    expect(() => requireElevenLabsConfig(getConfig())).toThrow(/ELEVENLABS_VOICE_ID/);
  });

  it("requireElevenLabsConfig returns both values when present", () => {
    process.env.ELEVENLABS_API_KEY = "sk_test";
    process.env.ELEVENLABS_VOICE_ID = "voice-1";
    const cfg = getConfig();
    expect(requireElevenLabsConfig(cfg)).toEqual({ apiKey: "sk_test", voiceId: "voice-1" });
  });
});
