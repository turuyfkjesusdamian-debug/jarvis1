import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getConfig, resetConfigForTests, requireOpenAiKey, requireElevenLabsConfig } from "../../src/config/index.js";

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
    delete process.env.JARVIS_ENV;
    delete process.env.JARVIS_REALTIME_MODEL;
    delete process.env.OPENAI_API_KEY;

    const cfg = getConfig();
    expect(cfg.logLevel).toBe("info");
    expect(cfg.env).toBe("development");
    expect(cfg.port).toBe(3939);
    expect(cfg.realtimeModel).toBe("gpt-realtime");
    expect(cfg.openaiApiKey).toBeUndefined();
  });

  it("never requires OPENAI_API_KEY to load", () => {
    delete process.env.OPENAI_API_KEY;
    expect(() => getConfig()).not.toThrow();
  });

  it("throws a clear error for an invalid enum value", () => {
    process.env.JARVIS_LOG_LEVEL = "not-a-level";
    expect(() => getConfig()).toThrow(/Invalid configuration/);
  });

  it("requireOpenAiKey throws when the key is missing", () => {
    delete process.env.OPENAI_API_KEY;
    const cfg = getConfig();
    expect(() => requireOpenAiKey(cfg)).toThrow(/OPENAI_API_KEY/);
  });

  it("requireOpenAiKey returns the key when present", () => {
    process.env.OPENAI_API_KEY = "sk-test-123";
    const cfg = getConfig();
    expect(requireOpenAiKey(cfg)).toBe("sk-test-123");
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
