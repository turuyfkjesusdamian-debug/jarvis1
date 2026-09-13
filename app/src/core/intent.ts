export type Intent = "tasks" | "notes" | "memory" | "schedule" | "general";

interface IntentRule {
  intent: Intent;
  patterns: RegExp[];
}

const RULES: IntentRule[] = [
  {
    intent: "schedule",
    patterns: [/qu[eé] tengo (hoy|ma[ñn]ana)/i, /my (day|schedule)/i, /what.*(today|tomorrow)/i, /agenda/i],
  },
  {
    intent: "tasks",
    patterns: [/tarea/i, /\btask/i, /pendiente/i, /to-?do/i],
  },
  {
    intent: "memory",
    patterns: [
      /recu[eé]rdame/i,
      /\bremember\b/i,
      /no olvides/i,
      /\bforget\b/i,
      /olvida/i,
      // Recall questions ("what do you remember about X"), not just save instructions.
      /qu[eé] recuerdas/i,
      /te acuerdas/i,
      /recuerdas algo/i,
      /do you remember/i,
      /what.*remember/i,
    ],
  },
  {
    intent: "notes",
    patterns: [/\bnota/i, /\bnote\b/i, /vault/i, /obsidian/i],
  },
];

/**
 * Cheap, deterministic intent classification (see JARVIS/ARCHITECTURE.md §
 * Retrieval strategy). Swappable for a model-based classifier later without
 * changing this function's signature.
 */
export function classifyIntent(utterance: string): Intent {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(utterance))) return rule.intent;
  }
  return "general";
}
