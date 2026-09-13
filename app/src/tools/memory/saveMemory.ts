import { z } from "zod";
import type { Tool } from "../types.js";
import { MEMORY_CATEGORIES } from "../../memory/permanentMemory.js";

const paramsSchema = z.object({
  category: z.enum(MEMORY_CATEGORIES as [string, ...string[]]),
  text: z.string().min(1),
});

export const saveMemory: Tool<z.infer<typeof paramsSchema>, { category: string }> = {
  name: "memory.saveMemory",
  description: "Persist a fact to permanent memory under a category (user, preferences, projects, people, important-facts). Use only for facts explicitly worth remembering long-term — see JARVIS/MEMORY.md.",
  permission: "write",
  parametersSchema: paramsSchema,
  async run(params, ctx) {
    await ctx.memory.permanent.save({
      category: params.category as any,
      date: new Date().toISOString().slice(0, 10),
      text: params.text,
      provenance: "tool-call",
    });
    return { ok: true, data: { category: params.category } };
  },
};
