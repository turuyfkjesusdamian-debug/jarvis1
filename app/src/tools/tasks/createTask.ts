import { z } from "zod";
import { formatTaskLine } from "./taskLines.js";
import type { Tool } from "../types.js";

const DEFAULT_TASKS_FILE = "Tasks/tasks.md";

const paramsSchema = z.object({
  text: z.string().min(1),
  project: z.string().optional(),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  file: z.string().optional(),
});

export const createTask: Tool<z.infer<typeof paramsSchema>, { file: string }> = {
  name: "tasks.createTask",
  description: "Add a new open task (as a Markdown checklist item) to a tasks file, defaulting to Tasks/tasks.md.",
  permission: "write",
  parametersSchema: paramsSchema,
  async run(params, ctx) {
    const file = params.file ?? DEFAULT_TASKS_FILE;
    const line = formatTaskLine(params.text, params.project, params.due);
    try {
      if (await ctx.vaultReader.exists(file)) {
        await ctx.vaultReader.appendToNote(file, line);
      } else {
        await ctx.vaultReader.writeNote(file, `# Tasks\n\n${line}\n`, { title: "Tasks", tags: ["tasks"] });
      }
      return { ok: true, data: { file } };
    } catch (err) {
      return { ok: false, error: `Could not create task: ${String(err)}` };
    }
  },
};
