import type { Intent } from "./intent.js";
import type { ToolRouter } from "./toolRouter.js";
import type { ToolCallOutcome } from "./toolRouter.js";
import { extractKeywords } from "./keywords.js";

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
    case "memory": {
      const keywords = extractKeywords(utterance);
      // Fall back to the raw utterance if nothing survived keyword
      // extraction (e.g. a very short question) so search still runs.
      const query = keywords.length > 0 ? keywords.join(" ") : utterance;
      return [await router.call({ name: "memory.searchMemory", params: { query } })];
    }
    case "general":
    default:
      return [];
  }
}
