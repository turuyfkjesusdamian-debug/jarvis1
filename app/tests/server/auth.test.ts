import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import { checkPassword, createSessionToken, isValidSessionToken, parseCookies, SESSION_COOKIE_NAME } from "../../src/server/auth.js";
import type { JarvisConfig } from "../../src/config/index.js";

function makeConfig(appPassword: string | undefined): JarvisConfig {
  return {
    geminiApiKey: undefined,
    geminiModel: "gemini-3.5-flash",
    elevenLabsApiKey: undefined,
    elevenLabsVoiceId: undefined,
    appPassword,
    vaultPath: "/tmp/vault",
    logLevel: "error",
    env: "test",
    port: 0,
    appDir: "/tmp/app",
  };
}

describe("auth", () => {
  describe("checkPassword", () => {
    it("returns false when no password is configured", () => {
      expect(checkPassword(makeConfig(undefined), "anything")).toBe(false);
    });

    it("returns true for a matching password", () => {
      expect(checkPassword(makeConfig("hunter2"), "hunter2")).toBe(true);
    });

    it("returns false for a non-matching password", () => {
      expect(checkPassword(makeConfig("hunter2"), "wrong")).toBe(false);
    });
  });

  describe("createSessionToken / isValidSessionToken", () => {
    it("throws when no password is configured", () => {
      expect(() => createSessionToken(makeConfig(undefined))).toThrow(/JARVIS_APP_PASSWORD/);
    });

    it("round-trips: a freshly created token is valid", () => {
      const cfg = makeConfig("hunter2");
      const token = createSessionToken(cfg);
      expect(isValidSessionToken(cfg, token)).toBe(true);
    });

    it("rejects a token signed with a different password", () => {
      const token = createSessionToken(makeConfig("hunter2"));
      expect(isValidSessionToken(makeConfig("different"), token)).toBe(false);
    });

    it("rejects a tampered token", () => {
      const cfg = makeConfig("hunter2");
      const token = createSessionToken(cfg);
      const [expiresAt] = token.split(".");
      const tampered = `${expiresAt}.0000000000000000000000000000000000000000000000000000000000000000`;
      expect(isValidSessionToken(cfg, tampered)).toBe(false);
    });

    it("rejects an expired token", () => {
      const cfg = makeConfig("hunter2");
      const expiresAt = Date.now() - 1000;
      const signature = crypto.createHmac("sha256", cfg.appPassword as string).update(String(expiresAt)).digest("hex");
      const expiredToken = `${expiresAt}.${signature}`;
      expect(isValidSessionToken(cfg, expiredToken)).toBe(false);
    });

    it("rejects malformed tokens and missing tokens", () => {
      const cfg = makeConfig("hunter2");
      expect(isValidSessionToken(cfg, undefined)).toBe(false);
      expect(isValidSessionToken(cfg, "")).toBe(false);
      expect(isValidSessionToken(cfg, "not-a-token")).toBe(false);
    });

    it("returns false when no password is configured, even with a well-formed token", () => {
      const token = createSessionToken(makeConfig("hunter2"));
      expect(isValidSessionToken(makeConfig(undefined), token)).toBe(false);
    });
  });

  describe("parseCookies", () => {
    it("parses multiple cookies", () => {
      expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" });
    });

    it("returns an empty object for an undefined header", () => {
      expect(parseCookies(undefined)).toEqual({});
    });

    it("decodes URI-encoded values", () => {
      expect(parseCookies(`${SESSION_COOKIE_NAME}=hello%20world`)).toEqual({ [SESSION_COOKIE_NAME]: "hello world" });
    });
  });
});
