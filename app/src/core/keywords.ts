const STOPWORDS = new Set([
  "el", "la", "los", "las", "de", "que", "y", "a", "en", "un", "una", "sobre",
  "the", "a", "an", "of", "to", "in", "is", "what", "do", "i", "have", "you",
]);

/**
 * Extracts significant words from an utterance for keyword-based matching
 * (see JARVIS/ARCHITECTURE.md § Retrieval strategy — no embeddings in v1).
 * Shared by notes search and memory recall so both degrade the same way.
 */
export function extractKeywords(utterance: string): string[] {
  return utterance
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 8);
}
