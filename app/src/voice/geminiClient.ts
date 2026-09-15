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
  | { action: "describe_screen" }
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
- describe_screen: preguntar, pedir que describa, lea o explique algo que está visible ahora mismo en la pantalla del teléfono (un mensaje, una imagen, una opción, cualquier contenido en pantalla). Sin parámetros.
- none: cualquier otra cosa — preguntas generales que no dependen de mirar la pantalla, conversación normal, saludos, pedir que recuerde o gestione tareas/notas/memoria, o cualquier instrucción ambigua. Ante la duda, responde none: es mejor no actuar que actuar mal.

Nunca clasifiques como acción nada relacionado con enviar mensajes de WhatsApp o hacer llamadas telefónicas — eso se maneja siempre por otro camino y jamás debe pasar por aquí; si detectas esa intención, responde none.

Responde ÚNICAMENTE con un objeto JSON compacto, sin texto adicional ni markdown, con una de estas formas exactas:
{"action": "open_app", "name": "..."}
{"action": "play_media", "query": "..."}
{"action": "directions", "destination": "...", "origin": "..."}
{"action": "nearby", "query": "..."}
{"action": "tap_element", "query": "..."}
{"action": "describe_screen"}
{"action": "none"}

Ejemplos:
"reproduce boys don't cry" -> {"action": "play_media", "query": "boys don't cry"}
"toca el botón de enviar" -> {"action": "tap_element", "query": "enviar"}
"llévame al aeropuerto" -> {"action": "directions", "destination": "aeropuerto"}
"hay alguna farmacia cerca" -> {"action": "nearby", "query": "farmacia"}
"quiero usar instagram" -> {"action": "open_app", "name": "instagram"}
"¿qué dice este mensaje?" -> {"action": "describe_screen"}
"¿quién me escribió?" -> {"action": "describe_screen"}
"qué opciones tengo aquí" -> {"action": "describe_screen"}
"describe la pantalla" -> {"action": "describe_screen"}
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
      case "describe_screen":
        return { action: "describe_screen" };
      default:
        return { action: "none" };
    }
  } catch {
    return { action: "none" };
  }
}

// --- Screen vision: answering questions about, and locating elements
// within, a JPEG screenshot of the Android app's current screen ---
// Only ever called on the user's own explicit request in that turn (a
// "describe_screen" classification, or a "toca X" whose on-device
// accessibility-tree text match already came up empty) — see
// JARVIS/ARCHITECTURE.md § Decisions and JARVIS/SECURITY.md § Android app
// actions for why a screenshot leaving the device at all is treated as a
// materially bigger privacy step than every other command here, and why
// that's still an acceptable trade for a capability the user explicitly
// asked for.

const DESCRIBE_SCREEN_SYSTEM_PROMPT = `Eres JARVIS, el asistente del usuario. Se te muestra una captura de la pantalla actual de su teléfono junto con una pregunta o instrucción sobre lo que se ve ahí. Responde de forma breve y natural, como si hablaras en voz alta, contestando exactamente lo que se te pregunta sobre esa imagen. No menciones que es una "captura de pantalla" ni expliques tu proceso — simplemente responde lo que ves, en español, dirigiéndote al usuario como "señor".`;

/**
 * Answers a question about whatever is currently visible on the Android
 * app's screen, given a JPEG screenshot (base64, no data: URI prefix).
 * Called only when classifyDeviceCommand returns "describe_screen" — see
 * JarvisListenerService.
 *
 * Throws on failure (missing config, a non-OK response, no text back):
 * unlike classifyDeviceCommand there's no safe silent "none" to fall back
 * to here, so the caller surfaces this as a spoken apology instead.
 */
export async function describeScreen(cfg: JarvisConfig, question: string, imageBase64: string): Promise<string> {
  const { apiKey, model } = requireGeminiConfig(cfg);
  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: question }, { inlineData: { mimeType: "image/jpeg", data: imageBase64 } }],
        },
      ],
      systemInstruction: { parts: [{ text: DESCRIBE_SCREEN_SYSTEM_PROMPT }] },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger.error("Gemini screen description failed", { status: response.status });
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

export interface LocatedPoint {
  found: boolean;
  /** Normalized 0-1000 on each axis (0,0 top-left; 1000,1000 bottom-right) —
   * Gemini's own spatial-grounding convention. Only present when found. */
  x?: number;
  y?: number;
}

const LOCATE_ELEMENT_SYSTEM_PROMPT = `Se te muestra una captura de la pantalla actual de un teléfono Android y la descripción de un elemento que hay que tocar (un botón, un ícono, una pieza en un juego, cualquier cosa visible). Devuelve ÚNICAMENTE un JSON compacto con la posición de su centro, usando un sistema de coordenadas normalizado de 0 a 1000 en cada eje (0,0 es la esquina superior izquierda; 1000,1000 la esquina inferior derecha), sin texto adicional ni markdown:

{"found": true, "x": 500, "y": 500}

Si no encuentras en la imagen nada que coincida claramente con la descripción, responde exactamente:
{"found": false}`;

/**
 * Locates a described on-screen element within a JPEG screenshot (base64,
 * no data: URI prefix) — the vision fallback for "toca X" when
 * JarvisAccessibilityService's own accessibility-tree text search already
 * found nothing (e.g. a custom-drawn view, an icon with no label). See
 * JarvisListenerService and JARVIS/ARCHITECTURE.md § Decisions.
 *
 * Never throws: resolves to `{ found: false }` on missing config, a failed
 * request, or a response that doesn't parse as the expected shape, so the
 * caller can always safely fall back to "no encontré nada, señor".
 */
export async function locateScreenElement(
  cfg: JarvisConfig,
  description: string,
  imageBase64: string
): Promise<LocatedPoint> {
  if (!cfg.geminiApiKey) return { found: false };
  try {
    const { apiKey, model } = requireGeminiConfig(cfg);
    const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: `Elemento a tocar: ${description}` },
              { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
            ],
          },
        ],
        systemInstruction: { parts: [{ text: LOCATE_ELEMENT_SYSTEM_PROMPT }] },
        generationConfig: { responseMimeType: "application/json" },
      }),
    });
    if (!response.ok) {
      logger.warn("Gemini element location failed", { status: response.status });
      return { found: false };
    }
    const json = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
    if (!text) return { found: false };
    const data = JSON.parse(text) as { found?: boolean; x?: number; y?: number };
    if (data.found === true && typeof data.x === "number" && typeof data.y === "number") {
      return { found: true, x: data.x, y: data.y };
    }
    return { found: false };
  } catch (err) {
    logger.warn("Gemini element location errored", { error: err instanceof Error ? err.message : String(err) });
    return { found: false };
  }
}
