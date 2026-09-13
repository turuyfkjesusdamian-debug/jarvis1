import { z } from "zod";
import type { Tool } from "../types.js";
import { MEMORY_CATEGORIES } from "../../memory/permanentMemory.js";

const paramsSchema = z.object({
  category: z.enum(MEMORY_CATEGORIES as [string, ...string[]]),
  textMatch: z.string().min(1),
});

export const forgetMemory: Tool<z.infer<typeof paramsSchema>, { removed: boolean }> = {
  name: "memory.forgetMemory",
  description: "Remove a previously remembered fact matching text from a memory category. Destructive — requires user confirmation.",
  permission: "destructive",
  parametersSchema: paramsSchema,
  async run(params, ctx) {
    const removed = await ctx.memory.permanent.forget(params.category as any, params.textMatch);
    if (!removed) {
      return { ok: false, error: `No fact matching "${params.textMatch}" found in ${params.category}.` };
    }
    return { ok: true, data: { removed } };
  },
};
