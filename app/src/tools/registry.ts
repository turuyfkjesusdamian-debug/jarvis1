import { logger } from "../logging/logger.js";
import type { AnyTool, ToolContext, ToolResult } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register(tool: AnyTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  list(): AnyTool[] {
    return [...this.tools.values()];
  }

  /** Lightweight name+description listing, used by the debug tool-listing endpoint. */
  describeForModel(): { name: string; description: string }[] {
    return this.list().map((t) => ({ name: t.name, description: t.description }));
  }

  async invoke(name: string, rawParams: unknown, ctx: ToolContext): Promise<ToolResult<unknown>> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `Unknown tool: ${name}` };
    }

    const parsed = tool.parametersSchema.safeParse(rawParams);
    if (!parsed.success) {
      logger.warn("Tool call rejected: invalid parameters", { tool: name, issues: parsed.error.issues });
      return { ok: false, error: `Invalid parameters: ${parsed.error.message}` };
    }

    if (tool.permission === "destructive" && !ctx.confirmed) {
      logger.warn("Destructive tool call blocked: not confirmed", { tool: name });
      return { ok: false, error: "This action is destructive and requires user confirmation first." };
    }

    const startedAt = Date.now();
    try {
      const result = await tool.run(parsed.data, ctx);
      logger.info("Tool executed", {
        tool: name,
        permission: tool.permission,
        ok: result.ok,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      logger.error("Tool threw an unexpected error", { tool: name, error: String(err) });
      return { ok: false, error: "Internal error while executing tool." };
    }
  }
}
