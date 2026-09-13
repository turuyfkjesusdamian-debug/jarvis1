import type { MemoryCategory } from "./permanentMemory.js";

export interface PersistDecision {
  persist: boolean;
  category?: MemoryCategory;
  reason: string;
}

const EXPLICIT_PATTERNS = [
  /\bremember (that|this)?\b/i,
  /\brecu[eé]rdame\b/i,
  /\bno olvides\b/i,
  /\bten en cuenta\b/i,
  /\bdon'?t forget\b/i,
];

const PREFERENCE_PATTERNS = [/\bi (always|never|prefer)\b/i, /\bsiempre (quiero|prefiero)\b/i, /\bprefiero\b/i];

const PROJECT_PATTERNS = [/\bproject\b/i, /\bproyecto\b/i];
const PEOPLE_PATTERNS = [/\bmy (wife|husband|boss|friend|colleague|manager)\b/i, /\bmi (jefe|amigo|colega)\b/i];

/**
 * Decides whether an utterance is worth persisting to permanent memory, and
 * to which category. Deliberately conservative (see JARVIS/MEMORY.md §
 * "What deserves persistence") — false negatives are preferred over
 * cluttering permanent memory. An explicit "remember" request always wins.
 */
export function shouldPersist(utterance: string): PersistDecision {
  if (EXPLICIT_PATTERNS.some((p) => p.test(utterance))) {
    return { persist: true, category: "important-facts", reason: "explicit-instruction" };
  }
  if (PREFERENCE_PATTERNS.some((p) => p.test(utterance))) {
    return { persist: true, category: "preferences", reason: "stable-preference" };
  }
  if (PROJECT_PATTERNS.some((p) => p.test(utterance))) {
    return { persist: true, category: "projects", reason: "project-mention" };
  }
  if (PEOPLE_PATTERNS.some((p) => p.test(utterance))) {
    return { persist: true, category: "people", reason: "relationship-fact" };
  }
  return { persist: false, reason: "no-persistence-signal" };
}
