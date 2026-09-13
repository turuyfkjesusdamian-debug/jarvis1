import type { Intent } from "./intent.js";
import type { ToolRouter } from "./toolRouter.js";
import type { ToolCallOutcome } from "./toolRouter.js";

/**
 * Maps intent → the minimal set of deterministic tool calls worth
 * pre-fetching before composing a reply, so the text-mode fallback (and
 * the realtime session's initial context) never needs the whole vault.
 * See JARVIS/ARCHITECTURE.md § Retrieval strategy.
 */
export async function gatherContext(
  intent: Intent,
  utterance: string,
  router: ToolRouter
): Promise<ToolCallOutcome[]> {
  switch (intent) {
    case "schedule":
      return [
        await router.call({ name: "tasks.listTasks", params: {} }),
        await router.call({ name: "system.getCurrentTime", params: {} }),
      ];
    case "tasks":
      return [await router.call({ name: "tasks.listTasks", params: {} })];
    case "notes": {
      const keywords = extractKeywords(utterance);
      return [await router.call({ name: "obsidian.searchNotes", params: { keywords, limit: 5 } })];
    }
    case "memory":
      return [await router.call({ name: "memory.searchMemory", params: { query: utterance } })];
    case "general":
    default:
      return [];
  }
}

const STOPWORDS = new Set([
  "el", "la", "los", "las", "de", "que", "y", "a", "en", "un", "una",
  "the", "a", "an", "of", "to", "in", "is", "what", "do", "i", "have",
]);

function extractKeywords(utterance: string): string[] {
  return utterance
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 8);
}
