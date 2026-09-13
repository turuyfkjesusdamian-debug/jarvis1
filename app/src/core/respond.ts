import type { Intent } from "./intent.js";
import type { ToolCallOutcome } from "./toolRouter.js";
import type { MemoryFact } from "../memory/permanentMemory.js";

/**
 * Deterministic, template-based reply composer used when no model call is
 * made (e.g. no GEMINI_API_KEY configured, or in tests) or for intents
 * that never need one (tasks/schedule/notes/memory always use this). This
 * exists so the app is usable and testable without any external API. Tone
 * follows JARVIS/PERSONA.md.
 *
 * `justPersisted` is set when this same utterance was just written to
 * permanent memory (see MemoryEngine.recordUtterance) — in that case the
 * right reply is a plain confirmation ("Entendido, lo recordaré."), never
 * an echo of the utterance itself back at the user.
 */
export function composeReply(intent: Intent, outcomes: ToolCallOutcome[], justPersisted?: MemoryFact): string {
  switch (intent) {
    case "tasks":
    case "schedule": {
      const tasksOutcome = outcomes.find((o) => o.name === "tasks.listTasks");
      if (tasksOutcome?.result.ok) {
        const tasks = tasksOutcome.result.data as { text: string }[];
        if (tasks.length === 0) return "No tienes tareas pendientes registradas.";
        const preview = tasks.slice(0, 3).map((t) => t.text).join("; ");
        return `Tienes ${tasks.length} tarea${tasks.length === 1 ? "" : "s"} pendiente${tasks.length === 1 ? "" : "s"}: ${preview}.`;
      }
      return "No pude consultar tus tareas en este momento.";
    }
    case "notes": {
      const searchOutcome = outcomes.find((o) => o.name === "obsidian.searchNotes");
      if (searchOutcome?.result.ok) {
        const notes = searchOutcome.result.data as { title: string }[];
        if (notes.length === 0) return "No encontré notas relevantes en el vault.";
        return `Encontré ${notes.length} nota${notes.length === 1 ? "" : "s"}: ${notes.map((n) => n.title).join(", ")}.`;
      }
      return "No pude buscar en el vault en este momento.";
    }
    case "memory": {
      if (justPersisted) return "Entendido, lo recordaré.";

      const memOutcome = outcomes.find((o) => o.name === "memory.searchMemory");
      if (memOutcome?.result.ok) {
        const facts = memOutcome.result.data as { text: string }[];
        if (facts.length === 0) return "No tengo nada guardado sobre eso.";
        return `Esto es lo que tengo guardado: ${facts.map((f) => f.text).join("; ")}.`;
      }
      return "No pude consultar la memoria en este momento.";
    }
    case "general":
    default:
      return "Entendido.";
  }
}
