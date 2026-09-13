import { z } from "zod";
import type { Tool } from "../types.js";
import type { MemoryFact } from "../../memory/permanentMemory.js";

const paramsSchema = z.object({
  query: z.string().min(1),
});

export const searchMemory: Tool<z.infer<typeof paramsSchema>, MemoryFact[]> = {
  name: "memory.searchMemory",
  description: "Search permanent memory (JARVIS/MEMORY/*.md) for facts matching a query.",
  permission: "read",
  parametersSchema: paramsSchema,
  async run(params, ctx) {
    const facts = await ctx.memory.permanent.search(params.query);
    return { ok: true, data: facts };
  },
};
