import { z } from "zod";
import { parseTaskLines, formatTaskLine, replaceLine } from "./taskLines.js";
import type { Tool } from "../types.js";

const TASKS_FOLDER = "Tasks";

const paramsSchema = z.object({
  matchText: z.string().min(1),
  newText: z.string().optional(),
  newProject: z.string().optional(),
  newDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  file: z.string().optional(),
});

export const updateTask: Tool<z.infer<typeof paramsSchema>, { file: string }> = {
  name: "tasks.updateTask",
  description: "Edit an existing task's text, project, or due date. Finds the first task whose text contains matchText.",
  permission: "write",
  parametersSchema: paramsSchema,
  async run(params, ctx) {
    const candidateFiles = params.file
      ? [params.file]
      : (await ctx.getIndex()).files.filter((f) => f.path.startsWith(`${TASKS_FOLDER}/`)).map((f) => f.path);

    for (const file of candidateFiles) {
      if (!(await ctx.vaultReader.exists(file))) continue;
      const note = await ctx.vaultReader.readNote(file);
      const tasks = parseTaskLines(note.content);
      const match = tasks.find((t) => t.text.toLowerCase().includes(params.matchText.toLowerCase()));
      if (!match) continue;

      const newLine = formatTaskLine(
        params.newText ?? match.text,
        params.newProject ?? match.project,
        params.newDue ?? match.due,
        match.done
      );
      const newContent = replaceLine(note.content, match.lineIndex, newLine);
      await ctx.vaultReader.writeNote(file, newContent, note.frontmatter);
      return { ok: true, data: { file } };
    }
    return { ok: false, error: `No task found matching "${params.matchText}".` };
  },
};
