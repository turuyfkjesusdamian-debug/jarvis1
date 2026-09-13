import { z } from "zod";
import { parseTaskLines, formatTaskLine, replaceLine } from "./taskLines.js";
import type { Tool } from "../types.js";

const TASKS_FOLDER = "Tasks";

const paramsSchema = z.object({
  matchText: z.string().min(1),
  file: z.string().optional(),
});

export const completeTask: Tool<z.infer<typeof paramsSchema>, { file: string; text: string }> = {
  name: "tasks.completeTask",
  description: "Mark the first open task whose text contains matchText as done. Searches all files under Tasks/ unless file is given.",
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
      const match = tasks.find((t) => !t.done && t.text.toLowerCase().includes(params.matchText.toLowerCase()));
      if (!match) continue;

      const newLine = formatTaskLine(match.text, match.project, match.due, true);
      const newContent = replaceLine(note.content, match.lineIndex, newLine);
      await ctx.vaultReader.writeNote(file, newContent, note.frontmatter);
      return { ok: true, data: { file, text: match.text } };
    }
    return { ok: false, error: `No open task found matching "${params.matchText}".` };
  },
};
