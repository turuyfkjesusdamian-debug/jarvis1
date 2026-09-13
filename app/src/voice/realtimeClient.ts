import type { JarvisConfig } from "../config/index.js";
import { requireOpenAiKey } from "../config/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import { zodToJsonSchema } from "../tools/jsonSchema.js";
import { PERSONA_SYSTEM_PROMPT } from "../core/persona.js";
import { logger } from "../logging/logger.js";
import type { EphemeralSessionResponse, RealtimeToolDefinition } from "./types.js";

// As of 2026, OpenAI's ephemeral-token endpoint for Realtime is
// /v1/realtime/client_secrets (the older /v1/realtime/sessions used in
// most 2025-era tutorials returns 404 now). Session config is nested
// under a `session` object with `type: "realtime"`. See
// JARVIS/ARCHITECTURE.md § Decisions.
const OPENAI_REALTIME_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

function toolsForModel(registry: ToolRegistry): RealtimeToolDefinition[] {
  return registry.list().map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: zodToJsonSchema(tool.parametersSchema),
  }));
}

/**
 * Mints a short-lived Realtime session token server-side. The long-lived
 * OPENAI_API_KEY never leaves this function — only the ephemeral client
 * secret is returned to the caller (and from there, to the browser). See
 * JARVIS/SECURITY.md § "Ephemeral realtime tokens only".
 */
export async function createEphemeralRealtimeSession(
  cfg: JarvisConfig,
  registry: ToolRegistry
): Promise<EphemeralSessionResponse> {
  const apiKey = requireOpenAiKey(cfg);
  const tools = toolsForModel(registry);

  const response = await fetch(OPENAI_REALTIME_CLIENT_SECRETS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: cfg.realtimeModel,
        instructions: PERSONA_SYSTEM_PROMPT,
        tools,
        tool_choice: "auto",
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger.error("Failed to mint Realtime client secret", { status: response.status });
    throw new Error(`OpenAI Realtime session creation failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const json = (await response.json()) as { value?: string; expires_at?: number | null };
  const clientSecret = json.value;
  if (!clientSecret) {
    throw new Error("OpenAI Realtime client secret response did not include a value.");
  }

  return {
    clientSecret,
    expiresAt: json.expires_at != null ? String(json.expires_at) : null,
    model: cfg.realtimeModel,
    tools,
  };
}
