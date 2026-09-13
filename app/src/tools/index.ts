import { ToolRegistry } from "./registry.js";
import { searchNotes } from "./obsidian/searchNotes.js";
import { readNote } from "./obsidian/readNote.js";
import { createNote } from "./obsidian/createNote.js";
import { updateNote } from "./obsidian/updateNote.js";
import { appendToNote } from "./obsidian/appendToNote.js";
import { listTasks } from "./tasks/listTasks.js";
import { createTask } from "./tasks/createTask.js";
import { completeTask } from "./tasks/completeTask.js";
import { updateTask } from "./tasks/updateTask.js";
import { searchMemory } from "./memory/searchMemory.js";
import { saveMemory } from "./memory/saveMemory.js";
import { forgetMemory } from "./memory/forgetMemory.js";
import { getCurrentTime } from "./system/getCurrentTime.js";
import { getSystemStatus } from "./system/getSystemStatus.js";

export { ToolRegistry } from "./registry.js";
export type { Tool, ToolContext, ToolResult, ToolPermission } from "./types.js";

/** Builds a registry with every built-in tool registered. See JARVIS/TOOLS.md. */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    searchNotes,
    readNote,
    createNote,
    updateNote,
    appendToNote,
    listTasks,
    createTask,
    completeTask,
    updateTask,
    searchMemory,
    saveMemory,
    forgetMemory,
    getCurrentTime,
    getSystemStatus,
  ]) {
    registry.register(tool);
  }
  return registry;
}
