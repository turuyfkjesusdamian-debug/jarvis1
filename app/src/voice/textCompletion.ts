import type { JarvisConfig } from "../config/index.js";
import { requireOpenAiKey } from "../config/index.js";
import { logger } from "../logging/logger.js";

const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Generates a natural conversational reply for the text-chat fallback's
 * "general" intent (small talk, open-ended questions — anything that
 * isn't a tasks/schedule/notes/memory request handled deterministically
 * by core/respond.ts). Real voice conversations don't use this — the
 * Realtime session itself is the model. This exists only because the text
 * fallback would otherwise have no model behind it at all. Callers should
 * fall back to the templated reply if this throws (e.g. no key, or the
 * API call fails) — see JarvisCore.
 */
export async function generateConversationalReply(
  cfg: JarvisConfig,
  systemPrompt: string,
  history: ChatTurn[],
  utterance: string
): Promise<string> {
  const apiKey = requireOpenAiKey(cfg);

  const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.textModel,
      messages: [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: utterance }],
      max_tokens: 300,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger.error("Text completion failed", { status: response.status });
    throw new Error(`Text completion failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Text completion returned no content.");
  }
  return content;
}
