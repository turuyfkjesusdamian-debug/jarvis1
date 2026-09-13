import { z } from "zod";
import { parseTaskLines } from "./taskLines.js";
import type { Tool } from "../types.js";

const paramsSchema = z.object({
  includeCompleted: z.boolean().optional().default(false),
  project: z.string().optional(),
  dueBefore: z.string().optional(),
});

export interface TaskListItem {
  file: string;
  done: boolean;
  text: string;
  project?: string;
  due?: string;
}

const TASKS_FOLDER = "Tasks";

export const listTasks: Tool<z.infer<typeof paramsSchema>, TaskListItem[]> = {
  name: "tasks.listTasks",
  description: "List tasks found under the Tasks/ folder, optionally filtered by project or due date.",
  permission: "read",
  parametersSchema: paramsSchema,
  async run(params, ctx) {
    const index = await ctx.getIndex();
    const files = index.files.filter((f) => f.path.startsWith(`${TASKS_FOLDER}/`));

    const items: TaskListItem[] = [];
    for (const file of files) {
      const note = await ctx.vaultReader.readNote(file.path);
      for (const task of parseTaskLines(note.content)) {
        if (!params.includeCompleted && task.done) continue;
        if (params.project && task.project !== params.project) continue;
        if (params.dueBefore && (!task.due || task.due >= params.dueBefore)) continue;
        items.push({ file: file.path, done: task.done, text: task.text, project: task.project, due: task.due });
      }
    }
    return { ok: true, data: items };
  },
};
