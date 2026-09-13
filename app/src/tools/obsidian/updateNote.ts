import { z } from "zod";
import type { Tool } from "../types.js";

const paramsSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  frontmatter: z.record(z.unknown()).optional(),
});

export const updateNote: Tool<z.infer<typeof paramsSchema>, { path: string }> = {
  name: "obsidian.updateNote",
  description: "Replace an existing note's content (and optionally frontmatter). Fails if the note does not exist — use createNote first.",
  permission: "write",
  parametersSchema: paramsSchema,
  async run(params, ctx) {
    if (!(await ctx.vaultReader.exists(params.path))) {
      return { ok: false, error: `Note does not exist: ${params.path}. Use createNote instead.` };
    }
    try {
      const existing = await ctx.vaultReader.readNote(params.path);
      await ctx.vaultReader.writeNote(params.path, params.content, params.frontmatter ?? existing.frontmatter);
      return { ok: true, data: { path: params.path } };
    } catch (err) {
      return { ok: false, error: `Could not update note: ${String(err)}` };
    }
  },
};
