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

const QUESTION_STARTERS =
  /^\s*(¿|qu[eé]|c[oó]mo|cu[aá]ndo|d[oó]nde|por qu[eé]|qui[eé]n|cu[aá]l|what|how|when|where|why|who|which|do you|does|is there|are there|can you)\b/i;

/**
 * A question about a topic ("what do you remember about the project?")
 * is not itself a fact about that topic — only declarative statements
 * should trigger the preference/project/people heuristics below. Explicit
 * "remember that ..." instructions are commands, not questions, and are
 * checked before this, so they're unaffected.
 */
function isQuestion(utterance: string): boolean {
  return utterance.trim().endsWith("?") || QUESTION_STARTERS.test(utterance);
}

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
  if (isQuestion(utterance)) {
    return { persist: false, reason: "question-not-a-fact" };
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
