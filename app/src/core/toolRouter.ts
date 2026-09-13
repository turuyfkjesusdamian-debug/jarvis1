import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import type { MemoryEngine } from "../memory/MemoryEngine.js";
import { VaultReader } from "../obsidian/VaultReader.js";
import { logger } from "../logging/logger.js";

const LAST_ACTIONS_PATH = "JARVIS/STATE/last-actions.md";
const MAX_LOGGED_ACTIONS = 20;

export interface ToolCallRequest {
  name: string;
  params: unknown;
  /** Must be explicitly set by the caller after the user confirmed, for destructive tools. */
  confirmed?: boolean;
}

export interface ToolCallOutcome {
  name: string;
  result: ToolResult<unknown>;
}

/**
 * Executes tool calls (from voice tool-call events or the text-mode
 * fallback) through the registry, records them to session memory, and
 * appends a bounded audit trail to JARVIS/STATE/last-actions.md.
 */
export class ToolRouter {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly memory: MemoryEngine,
    private readonly baseCtx: Omit<ToolContext, "memory" | "confirmed">,
    private readonly vaultReader: VaultReader,
    /**
     * Called after a "write"/"destructive" tool succeeds, so the cached
     * vault index doesn't go stale (e.g. a just-created task file must be
     * visible to the next listTasks/searchNotes call). Optional so tests
     * that don't care about index freshness can omit it.
     */
    private readonly onVaultMutated?: () => Promise<void>
  ) {}

  async call(request: ToolCallRequest): Promise<ToolCallOutcome> {
    const ctx: ToolContext = { ...this.baseCtx, memory: this.memory, confirmed: request.confirmed };
    const result = await this.registry.invoke(request.name, request.params, ctx);

    this.memory.session.addTurn({ role: "tool", toolName: request.name, content: JSON.stringify(result) });
    await this.recordAction(request.name, result);

    const tool = this.registry.get(request.name);
    if (result.ok && tool && tool.permission !== "read" && this.onVaultMutated) {
      await this.onVaultMutated();
    }

    return { name: request.name, result };
  }

  private async recordAction(name: string, result: ToolResult<unknown>): Promise<void> {
    try {
      const line = `- ${new Date().toISOString()} **${name}** → ${result.ok ? "ok" : `error: ${result.error}`}`;
      const exists = await this.vaultReader.exists(LAST_ACTIONS_PATH);
      const existing = exists ? (await this.vaultReader.readNote(LAST_ACTIONS_PATH)).content : "# Last actions\n";
      const lines = existing.split("\n").filter((l) => l.startsWith("- "));
      lines.push(line);
      const trimmed = lines.slice(-MAX_LOGGED_ACTIONS);
      await this.vaultReader.writeNote(LAST_ACTIONS_PATH, `# Last actions\n\n${trimmed.join("\n")}\n`, {
        type: "state",
        scope: "actions-log",
      });
    } catch (err) {
      logger.warn("Failed to record action to last-actions.md", { error: String(err) });
    }
  }
}
