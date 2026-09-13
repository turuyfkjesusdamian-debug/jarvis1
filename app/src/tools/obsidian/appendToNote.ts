import { z } from "zod";
import type { Tool } from "../types.js";

const paramsSchema = z.object({
  path: z.string().min(1),
  text: z.string().min(1),
});

export const appendToNote: Tool<z.infer<typeof paramsSchema>, { path: string }> = {
  name: "obsidian.appendToNote",
  description: "Append a line or block of text to the end of an existing note. Fails if the note does not exist.",
  permission: "write",
  parametersSchema: paramsSchema,
  async run(params, ctx) {
    if (!(await ctx.vaultReader.exists(params.path))) {
      return { ok: false, error: `Note does not exist: ${params.path}. Use createNote instead.` };
    }
    try {
      await ctx.vaultReader.appendToNote(params.path, params.text);
      return { ok: true, data: { path: params.path } };
    } catch (err) {
      return { ok: false, error: `Could not append to note: ${String(err)}` };
    }
  },
};
