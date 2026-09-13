import type { JarvisConfig } from "../config/index.js";
import { requireGeminiConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/**
 * Generates a natural conversational reply for the text/voice fallback's
 * "general" intent (small talk, open-ended questions — everything else is
 * handled deterministically by core/respond.ts). See JARVIS/ARCHITECTURE.md
 * § Decisions for why Gemini replaced OpenAI here. The API key is read
 * only via requireGeminiConfig and is passed as a query parameter per
 * Google's API — never logged (only the HTTP status is logged on error).
 */
export async function generateConversationalReply(
  cfg: JarvisConfig,
  systemPrompt: string,
  history: ChatTurn[],
  utterance: string
): Promise<string> {
  const { apiKey, model } = requireGeminiConfig(cfg);
  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const contents = [
    ...history.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.content }],
    })),
    { role: "user", parts: [{ text: utterance }] },
  ];

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger.error("Gemini generateContent failed", { status: response.status });
    throw new Error(`Gemini request failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const json = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = json.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) {
    throw new Error("Gemini response contained no text.");
  }
  return text;
}
