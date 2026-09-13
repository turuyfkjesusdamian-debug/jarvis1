import { z } from "zod";
import type { Tool } from "../types.js";
import { MEMORY_CATEGORIES } from "../../memory/permanentMemory.js";

const paramsSchema = z.object({});

export interface SystemStatusResult {
  vaultIndex: { generatedAt: string; fileCount: number };
  memoryFactCounts: Record<string, number>;
}

export const getSystemStatus: Tool<z.infer<typeof paramsSchema>, SystemStatusResult> = {
  name: "system.getSystemStatus",
  description: "Report app health: vault index freshness and permanent memory sizes.",
  permission: "read",
  parametersSchema: paramsSchema,
  async run(_params, ctx) {
    const index = await ctx.getIndex();
    const memoryFactCounts: Record<string, number> = {};
    for (const category of MEMORY_CATEGORIES) {
      memoryFactCounts[category] = (await ctx.memory.permanent.list(category)).length;
    }
    return {
      ok: true,
      data: {
        vaultIndex: { generatedAt: index.generatedAt, fileCount: index.files.length },
        memoryFactCounts,
      },
    };
  },
};
