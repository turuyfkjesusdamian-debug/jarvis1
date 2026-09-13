import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Tests must never depend on a developer's local app/.env (secrets
    // there are for manual runs, not CI) — force these unset regardless
    // of what's on disk, so the suite stays hermetic and network-free.
    // See JARVIS/DEVELOPMENT.md § Tests.
    env: {
      GEMINI_API_KEY: "",
      ELEVENLABS_API_KEY: "",
      ELEVENLABS_VOICE_ID: "",
      JARVIS_APP_PASSWORD: "",
    },
  },
});
