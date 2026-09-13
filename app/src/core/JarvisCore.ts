import path from "node:path";
import { VaultReader } from "../obsidian/VaultReader.js";
import { VaultIndexer } from "../obsidian/VaultIndexer.js";
import type { VaultIndex } from "../obsidian/types.js";
import { MemoryEngine } from "../memory/MemoryEngine.js";
import { createToolRegistry, type ToolRegistry } from "../tools/index.js";
import type { ToolContext } from "../tools/types.js";
import { ToolRouter } from "./toolRouter.js";
import { classifyIntent, type Intent } from "./intent.js";
import { gatherContext } from "./contextBuilder.js";
import { composeReply } from "./respond.js";
import { PERSONA_SYSTEM_PROMPT } from "./persona.js";
import { logger } from "../logging/logger.js";
import type { ToolCallOutcome } from "./toolRouter.js";
import { getConfig } from "../config/index.js";
import { generateConversationalReply, type ChatTurn } from "../voice/geminiClient.js";

const INDEX_RELATIVE_PATH = "JARVIS/INDEX/vault-index.json";

export interface HandleMessageResult {
  intent: Intent;
  reply: string;
  toolCalls: ToolCallOutcome[];
  /**
   * Set when a conversational model call was attempted and failed (e.g.
   * GEMINI_API_KEY configured but the request errored) — `reply` is still
   * the safe templated fallback, but surfacing this lets the UI show the
   * real reason instead of a silent, unexplained "Entendido.". Never a
   * secret: geminiClient.ts's errors never include the API key.
   */
  debugError?: string;
}

/**
 * Top-level orchestration facade. See JARVIS/ARCHITECTURE.md. Holds no
 * provider-specific knowledge itself — voice/ and server/ depend on this,
 * not the other way around.
 */
export class JarvisCore {
  readonly vaultReader: VaultReader;
  readonly memory: MemoryEngine;
  readonly tools: ToolRegistry;
  private readonly indexer: VaultIndexer;
  private readonly indexFilePath: string;
  private cachedIndex: VaultIndex | undefined;
  private readonly toolRouter: ToolRouter;

  constructor(vaultPath: string) {
    this.vaultReader = new VaultReader(vaultPath);
    this.indexer = new VaultIndexer(vaultPath);
    this.indexFilePath = path.join(vaultPath, INDEX_RELATIVE_PATH);
    this.memory = new MemoryEngine(this.vaultReader);
    this.tools = createToolRegistry();

    const baseCtx: Omit<ToolContext, "memory" | "confirmed"> = {
      vaultReader: this.vaultReader,
      getIndex: () => this.getIndex(),
    };
    this.toolRouter = new ToolRouter(this.tools, this.memory, baseCtx, this.vaultReader, () =>
      this.reindex().then(() => undefined)
    );
  }

  /** Loads the on-disk index if present, otherwise builds and persists a fresh one. */
  async init(): Promise<void> {
    await this.memory.shortTerm.ensureFresh();
    const existing = await this.indexer.readIndex(this.indexFilePath);
    this.cachedIndex = existing ?? (await this.indexer.reindex(this.indexFilePath));
    logger.info("JarvisCore initialized", { files: this.cachedIndex.files.length });
  }

  async reindex(): Promise<VaultIndex> {
    this.cachedIndex = await this.indexer.reindex(this.indexFilePath);
    return this.cachedIndex;
  }

  private async getIndex(): Promise<VaultIndex> {
    if (!this.cachedIndex) {
      this.cachedIndex = await this.indexer.reindex(this.indexFilePath);
    }
    return this.cachedIndex;
  }

  getToolRouter(): ToolRouter {
    return this.toolRouter;
  }

  /**
   * Handles both typed and spoken input (voice mode transcribes speech
   * client-side and calls this exact same path — see JARVIS/ARCHITECTURE.md
   * § Decisions). Classifies intent, deterministically gathers the minimal
   * context via tools, and composes a reply. Tasks/schedule/notes/memory
   * intents always use the templated, deterministic reply in
   * core/respond.ts (no model call, no network). "general" (small talk,
   * open-ended questions) uses a real conversational model call when
   * GEMINI_API_KEY is configured, falling back to the static template
   * otherwise or if the call fails — see voice/geminiClient.ts.
   */
  async handleTextMessage(utterance: string): Promise<HandleMessageResult> {
    const justPersisted = await this.memory.recordUtterance(utterance);
    const intent = classifyIntent(utterance);
    const toolCalls = await gatherContext(intent, utterance, this.toolRouter);
    const { reply, debugError } = await this.composeReplyForIntent(intent, utterance, toolCalls, justPersisted);
    this.memory.session.addTurn({ role: "assistant", content: reply });
    await this.memory.flushSessionToDisk();
    return { intent, reply, toolCalls, debugError };
  }

  private async composeReplyForIntent(
    intent: Intent,
    utterance: string,
    toolCalls: ToolCallOutcome[],
    justPersisted: Awaited<ReturnType<MemoryEngine["recordUtterance"]>>
  ): Promise<{ reply: string; debugError?: string }> {
    if (intent === "general") {
      const cfg = getConfig();
      if (cfg.geminiApiKey) {
        try {
          const history: ChatTurn[] = this.memory.session
            .getRecent(6)
            .filter((t): t is typeof t & { role: "user" | "assistant" } => t.role === "user" || t.role === "assistant")
            .map((t) => ({ role: t.role, content: t.content }));
          const reply = await generateConversationalReply(cfg, PERSONA_SYSTEM_PROMPT, history, utterance);
          return { reply };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("Conversational reply failed, using templated fallback", { error: message });
          return { reply: composeReply(intent, toolCalls, justPersisted), debugError: message };
        }
      }
    }
    return { reply: composeReply(intent, toolCalls, justPersisted) };
  }
}
