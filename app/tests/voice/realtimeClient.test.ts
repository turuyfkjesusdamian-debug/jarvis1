import { describe, it, expect, vi, afterEach } from "vitest";
import { createEphemeralRealtimeSession } from "../../src/voice/realtimeClient.js";
import { createToolRegistry } from "../../src/tools/index.js";
import type { JarvisConfig } from "../../src/config/index.js";

function makeConfig(overrides: Partial<JarvisConfig> = {}): JarvisConfig {
  return {
    openaiApiKey: "sk-test",
    vaultPath: "/tmp/vault",
    logLevel: "error",
    env: "test",
    port: 3939,
    realtimeModel: "gpt-realtime",
    appDir: "/tmp/app",
    ...overrides,
  };
}

describe("createEphemeralRealtimeSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never sends the long-lived API key anywhere but the Authorization header, and never returns it", async () => {
    let capturedAuth: string | null = null;
    let capturedBody: any = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedAuth = (init.headers as Record<string, string>).Authorization;
        capturedBody = JSON.parse(init.body as string);
        return {
          ok: true,
          json: async () => ({ client_secret: { value: "ephemeral-abc", expires_at: "2026-01-01T00:00:00Z" } }),
        } as Response;
      })
    );

    const registry = createToolRegistry();
    const session = await createEphemeralRealtimeSession(makeConfig(), registry);

    expect(capturedAuth).toBe("Bearer sk-test");
    expect(capturedBody.model).toBe("gpt-realtime");
    expect(capturedBody.tools.length).toBeGreaterThan(0);
    expect(session.clientSecret).toBe("ephemeral-abc");
    expect(JSON.stringify(session)).not.toContain("sk-test");
    expect(capturedBody.modalities).toEqual(["audio", "text"]);
  });

  it("throws when OPENAI_API_KEY is not configured", async () => {
    const registry = createToolRegistry();
    await expect(createEphemeralRealtimeSession(makeConfig({ openaiApiKey: undefined }), registry)).rejects.toThrow(
      /OPENAI_API_KEY/
    );
  });

  it("surfaces a clear error when OpenAI returns a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, text: async () => "unauthorized" } as Response))
    );
    const registry = createToolRegistry();
    await expect(createEphemeralRealtimeSession(makeConfig(), registry)).rejects.toThrow(/401/);
  });
});
