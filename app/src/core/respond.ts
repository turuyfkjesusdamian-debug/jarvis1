import type { Intent } from "./intent.js";
import type { ToolCallOutcome } from "./toolRouter.js";
import type { MemoryFact } from "../memory/permanentMemory.js";

/**
 * Deterministic, template-based reply composer used when no model call is
 * made (e.g. no GEMINI_API_KEY configured, or in tests) or for intents
 * that never need one (tasks/schedule/notes/memory always use this). This
 * exists so the app is usable and testable without any external API. Tone
 * follows JARVIS/PERSONA.md — the classic composed butler, addresses the
 * user as "señor", dry wit permitted but never at the expense of clarity.
 *
 * `justPersisted` is set when this same utterance was just written to
 * permanent memory (see MemoryEngine.recordUtterance) — in that case the
 * right reply is a plain confirmation, never an echo of the utterance
 * itself back at the user.
 */
export function composeReply(intent: Intent, outcomes: ToolCallOutcome[], justPersisted?: MemoryFact): string {
  switch (intent) {
    case "tasks":
    case "schedule": {
      const tasksOutcome = outcomes.find((o) => o.name === "tasks.listTasks");
      if (tasksOutcome?.result.ok) {
        const tasks = tasksOutcome.result.data as { text: string }[];
        if (tasks.length === 0) return "Ninguna tarea pendiente, señor. El horizonte está despejado.";
        const preview = tasks.slice(0, 3).map((t) => t.text).join("; ");
        return `Tiene ${tasks.length} tarea${tasks.length === 1 ? "" : "s"} pendiente${tasks.length === 1 ? "" : "s"}, señor: ${preview}.`;
      }
      return "Me temo que no puedo consultar sus tareas en este momento, señor.";
    }
    case "notes": {
      const searchOutcome = outcomes.find((o) => o.name === "obsidian.searchNotes");
      if (searchOutcome?.result.ok) {
        const notes = searchOutcome.result.data as { title: string }[];
        if (notes.length === 0) return "No he encontrado notas relevantes al respecto, señor.";
        return `He encontrado ${notes.length} nota${notes.length === 1 ? "" : "s"}, señor: ${notes.map((n) => n.title).join(", ")}.`;
      }
      return "Me temo que no puedo buscar en el vault en este momento, señor.";
    }
    case "memory": {
      if (justPersisted) return "Por supuesto, señor. Lo recordaré.";

      const memOutcome = outcomes.find((o) => o.name === "memory.searchMemory");
      if (memOutcome?.result.ok) {
        const facts = memOutcome.result.data as { text: string }[];
        if (facts.length === 0) return "No dispongo de nada guardado sobre eso, señor.";
        return `Esto es lo que tengo registrado, señor: ${facts.map((f) => f.text).join("; ")}.`;
      }
      return "Me temo que no puedo consultar la memoria en este momento, señor.";
    }
    case "general":
    default:
      return "Entendido, señor.";
  }
}
