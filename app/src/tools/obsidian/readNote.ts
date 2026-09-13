import { z } from "zod";
import type { Tool } from "../types.js";

const paramsSchema = z.object({
  path: z.string().min(1),
  section: z.string().optional(),
});

export interface ReadNoteToolResult {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
  section?: string;
}

export const readNote: Tool<z.infer<typeof paramsSchema>, ReadNoteToolResult> = {
  name: "obsidian.readNote",
  description: "Read a single note by its vault-relative path, optionally narrowed to one heading section.",
  permission: "read",
  parametersSchema: paramsSchema,
  async run(params, ctx) {
    try {
      const result = await ctx.vaultReader.readNote(params.path, params.section);
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: `Could not read note "${params.path}": ${String(err)}` };
    }
  },
};
