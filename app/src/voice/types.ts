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
}
