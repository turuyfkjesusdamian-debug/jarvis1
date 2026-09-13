import { z } from "zod";
import type { Tool } from "../types.js";

const paramsSchema = z.object({
  path: z.string().min(1),
  content: z.string().default(""),
  frontmatter: z.record(z.unknown()).optional(),
});

export const createNote: Tool<z.infer<typeof paramsSchema>, { path: string }> = {
  name: "obsidian.createNote",
  description: "Create a new note at a vault-relative path with optional frontmatter. Fails if the note already exists.",
  permission: "write",
  parametersSchema: paramsSchema,
  async run(params, ctx) {
    if (await ctx.vaultReader.exists(params.path)) {
      return { ok: false, error: `Note already exists: ${params.path}. Use updateNote or appendToNote instead.` };
    }
    try {
      await ctx.vaultReader.writeNote(params.path, params.content, params.frontmatter);
      return { ok: true, data: { path: params.path } };
    } catch (err) {
      return { ok: false, error: `Could not create note: ${String(err)}` };
    }
  },
};
