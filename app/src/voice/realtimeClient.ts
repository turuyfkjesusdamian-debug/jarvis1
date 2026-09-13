import type { JarvisConfig } from "../config/index.js";
import { requireOpenAiKey } from "../config/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import { zodToJsonSchema } from "../tools/jsonSchema.js";
import { PERSONA_SYSTEM_PROMPT } from "../core/persona.js";
import { logger } from "../logging/logger.js";
import type { EphemeralSessionResponse, RealtimeToolDefinition } from "./types.js";

const OPENAI_REALTIME_SESSIONS_URL = "https://api.openai.com/v1/realtime/sessions";

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
 * OPENAI_API_KEY never leaves this function — only the ephemeral
 * `client_secret` is returned to the caller (and from there, to the
 * browser). See JARVIS/SECURITY.md § "Ephemeral realtime tokens only".
 */
export async function createEphemeralRealtimeSession(
  cfg: JarvisConfig,
  registry: ToolRegistry
): Promise<EphemeralSessionResponse> {
  const apiKey = requireOpenAiKey(cfg);
  const tools = toolsForModel(registry);

  const response = await fetch(OPENAI_REALTIME_SESSIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.realtimeModel,
      instructions: PERSONA_SYSTEM_PROMPT,
      tools,
      modalities: ["audio", "text"],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger.error("Failed to mint Realtime session", { status: response.status });
    throw new Error(`OpenAI Realtime session creation failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const json = (await response.json()) as {
    client_secret?: { value?: string; expires_at?: string | null };
  };
  const clientSecret = json.client_secret?.value;
  if (!clientSecret) {
    throw new Error("OpenAI Realtime session response did not include a client secret.");
  }

  return {
    clientSecret,
    expiresAt: json.client_secret?.expires_at ?? null,
    model: cfg.realtimeModel,
    tools,
  };
}
