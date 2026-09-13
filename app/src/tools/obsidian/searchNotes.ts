import { z } from "zod";
import { retrieve } from "../../obsidian/retrieval.js";
import type { Tool } from "../types.js";

const paramsSchema = z.object({
  keywords: z.array(z.string()).optional(),
  folders: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(50).optional(),
});

export interface SearchNotesResult {
  path: string;
  title: string;
  tags: string[];
  score: number;
}

export const searchNotes: Tool<z.infer<typeof paramsSchema>, SearchNotesResult[]> = {
  name: "obsidian.searchNotes",
  description:
    "Search the vault index by keywords, folders, and/or tags. Returns matching file paths and titles, not full content — call readNote for a specific result.",
  permission: "read",
  parametersSchema: paramsSchema,
  async run(params, ctx) {
    const index = await ctx.getIndex();
    const matches = retrieve(index, params);
    return {
      ok: true,
      data: matches.map((m) => ({
        path: m.entry.path,
        title: m.entry.title,
        tags: m.entry.tags,
        score: Math.round(m.score * 100) / 100,
      })),
    };
  },
};
