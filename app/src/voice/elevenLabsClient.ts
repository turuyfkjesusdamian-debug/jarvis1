import type { JarvisConfig } from "../config/index.js";
import { requireElevenLabsConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";

const ELEVENLABS_TTS_URL = "https://api.elevenlabs.io/v1/text-to-speech";

/**
 * Synthesizes speech for a piece of text using ElevenLabs, returning raw
 * MP3 bytes. The API key is read only here, sent only in the `xi-api-key`
 * header, and never logged or returned to callers. See JARVIS/SECURITY.md.
 */
export async function synthesizeSpeech(cfg: JarvisConfig, text: string): Promise<Buffer> {
  const { apiKey, voiceId } = requireElevenLabsConfig(cfg);

  const response = await fetch(`${ELEVENLABS_TTS_URL}/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger.error("ElevenLabs speech synthesis failed", { status: response.status });
    throw new Error(`ElevenLabs speech synthesis failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
