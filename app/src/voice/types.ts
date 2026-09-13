export interface RealtimeToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface EphemeralSessionResponse {
  /** Short-lived token the browser uses to authenticate directly with OpenAI's Realtime endpoint. */
  clientSecret: string;
  expiresAt: string | null;
  model: string;
  tools: RealtimeToolDefinition[];
  /** When true, the session was created with text-only output — the browser must synthesize speech itself via /api/tts. */
  useElevenLabsSpeech: boolean;
}
