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

/** Result of classifying an Android voice command — see classifyDeviceCommand. */
export type DeviceCommandResult =
  | { action: "open_app"; name: string }
  | { action: "play_media"; query: string }
  | { action: "directions"; destination: string; origin?: string }
  | { action: "nearby"; query: string }
  | { action: "tap_element"; query: string }
  | { action: "none" };

// Deliberately excludes WhatsApp messages and phone calls — those must
// always go through JarvisListenerService's own deterministic regex +
// spoken confirmation, never a model call (JARVIS/SECURITY.md § Actions
// requiring confirmation). Few-shot examples are load-bearing here, not
// decorative: they're what keeps the model from classifying an ordinary
// question as an action.
const DEVICE_COMMAND_SYSTEM_PROMPT = `Eres un clasificador para el asistente de voz JARVIS en un teléfono Android. Dado lo que la persona acaba de decir (ya sin la palabra de activación "oye jarvis"), decide si es una petición para que el teléfono haga una de estas acciones, y con qué parámetros:

- open_app: abrir una aplicación instalada por su nombre. Parámetro: name.
- play_media: reproducir o buscar una canción, video u otro contenido multimedia. Parámetro: query.
- directions: pedir una ruta o cómo llegar a un lugar. Parámetros: destination (obligatorio), origin (opcional, solo si menciona un punto de partida distinto de la ubicación actual).
- nearby: buscar algo cercano a la ubicación actual. Parámetro: query.
- tap_element: tocar o presionar algo visible en la pantalla actual del teléfono. Parámetro: query (el texto de lo que hay que tocar).
- none: cualquier otra cosa — preguntas, conversación normal, saludos, pedir que recuerde o gestione tareas/notas/memoria, o cualquier instrucción ambigua. Ante la duda, responde none: es mejor no actuar que actuar mal.

Nunca clasifiques como acción nada relacionado con enviar mensajes de WhatsApp o hacer llamadas telefónicas — eso se maneja siempre por otro camino y jamás debe pasar por aquí; si detectas esa intención, responde none.

Responde ÚNICAMENTE con un objeto JSON compacto, sin texto adicional ni markdown, con una de estas formas exactas:
{"action": "open_app", "name": "..."}
{"action": "play_media", "query": "..."}
{"action": "directions", "destination": "...", "origin": "..."}
{"action": "nearby", "query": "..."}
{"action": "tap_element", "query": "..."}
{"action": "none"}

Ejemplos:
"reproduce boys don't cry" -> {"action": "play_media", "query": "boys don't cry"}
"toca el botón de enviar" -> {"action": "tap_element", "query": "enviar"}
"llévame al aeropuerto" -> {"action": "directions", "destination": "aeropuerto"}
"hay alguna farmacia cerca" -> {"action": "nearby", "query": "farmacia"}
"quiero usar instagram" -> {"action": "open_app", "name": "instagram"}
"¿qué tiempo hace hoy?" -> {"action": "none"}
"recuérdame comprar leche" -> {"action": "none"}
"envíale un mensaje a mamá" -> {"action": "none"}`;

/**
 * Classifies a voice command from the Android app into one of a small,
 * fixed set of on-device actions JarvisListenerService can execute
 * generically — beyond the exact phrasings it already matches
 * deterministically with regexes. Called only as a fallback, after those
 * regexes find no match, and only from the Android app (see
 * JARVIS/ARCHITECTURE.md § Decisions) — the web UI has no on-device
 * actions to perform.
 *
 * Never throws: returns `{ action: "none" }` on missing config, a failed
 * request, or a response that doesn't parse as one of the known shapes,
 * so the caller can always safely fall back to ordinary chat.
 */
export async function classifyDeviceCommand(cfg: JarvisConfig, utterance: string): Promise<DeviceCommandResult> {
  if (!cfg.geminiApiKey) return { action: "none" };
  try {
    const { apiKey, model } = requireGeminiConfig(cfg);
    const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: utterance }] }],
        systemInstruction: { parts: [{ text: DEVICE_COMMAND_SYSTEM_PROMPT }] },
        generationConfig: { responseMimeType: "application/json" },
      }),
    });
    if (!response.ok) {
      logger.warn("Device command classification failed", { status: response.status });
      return { action: "none" };
    }
    const json = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
    if (!text) return { action: "none" };
    return parseDeviceCommandResult(text);
  } catch (err) {
    logger.warn("Device command classification errored", { error: err instanceof Error ? err.message : String(err) });
    return { action: "none" };
  }
}

function parseDeviceCommandResult(text: string): DeviceCommandResult {
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    switch (data.action) {
      case "open_app": {
        const name = str(data.name);
        return name ? { action: "open_app", name } : { action: "none" };
      }
      case "play_media": {
        const query = str(data.query);
        return query ? { action: "play_media", query } : { action: "none" };
      }
      case "directions": {
        const destination = str(data.destination);
        return destination ? { action: "directions", destination, origin: str(data.origin) } : { action: "none" };
      }
      case "nearby": {
        const query = str(data.query);
        return query ? { action: "nearby", query } : { action: "none" };
      }
      case "tap_element": {
        const query = str(data.query);
        return query ? { action: "tap_element", query } : { action: "none" };
      }
      default:
        return { action: "none" };
    }
  } catch {
    return { action: "none" };
  }
}
