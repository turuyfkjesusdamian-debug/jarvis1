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
import { logger } from "../logging/logger.js";
import type { ToolCallOutcome } from "./toolRouter.js";

const INDEX_RELATIVE_PATH = "JARVIS/INDEX/vault-index.json";

export interface HandleMessageResult {
  intent: Intent;
  reply: string;
  toolCalls: ToolCallOutcome[];
}

/**
 * Top-level orchestration facade. See JARVIS/ARCHITECTURE.md. Holds no
 * OpenAI-specific knowledge — voice/ and server/ depend on this, not the
 * other way around.
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
   * Text-mode fallback: classify intent, deterministically gather the
   * minimal context via tools, and compose a templated reply. Real voice
   * conversations go through voice/RealtimeSession instead, where the
   * model itself drives tool-calling. See JARVIS/ARCHITECTURE.md and
   * core/respond.ts for why this path is intentionally simple.
   */
  async handleTextMessage(utterance: string): Promise<HandleMessageResult> {
    const justPersisted = await this.memory.recordUtterance(utterance);
    const intent = classifyIntent(utterance);
    const toolCalls = await gatherContext(intent, utterance, this.toolRouter);
    const reply = composeReply(intent, toolCalls, justPersisted);
    this.memory.session.addTurn({ role: "assistant", content: reply });
    await this.memory.flushSessionToDisk();
    return { intent, reply, toolCalls };
  }
}
