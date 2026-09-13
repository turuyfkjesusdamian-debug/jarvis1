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
      OPENAI_API_KEY: "",
    },
  },
});
