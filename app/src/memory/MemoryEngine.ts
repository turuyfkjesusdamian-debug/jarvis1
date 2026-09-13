import { VaultReader } from "../obsidian/VaultReader.js";
import { logger } from "../logging/logger.js";
import { SessionMemory } from "./sessionMemory.js";
import { ShortTermMemory } from "./shortTermMemory.js";
import { PermanentMemory, type MemoryCategory, type MemoryFact } from "./permanentMemory.js";
import { shouldPersist } from "./shouldPersist.js";

const SESSION_FILE_PATH = "JARVIS/STATE/current-session.md";

/** Facade over the three memory tiers (see JARVIS/MEMORY.md). */
export class MemoryEngine {
  readonly session: SessionMemory;
  readonly shortTerm: ShortTermMemory;
  readonly permanent: PermanentMemory;
  private readonly reader: VaultReader;

  constructor(reader: VaultReader) {
    this.reader = reader;
    this.session = new SessionMemory();
    this.shortTerm = new ShortTermMemory(reader);
    this.permanent = new PermanentMemory(reader);
  }

  /** Mirrors the in-memory session to disk for inspection/debugging (disposable). */
  async flushSessionToDisk(): Promise<void> {
    await this.reader.writeNote(SESSION_FILE_PATH, `# Current session\n\n${this.session.renderForFile()}\n`, {
      type: "state",
      scope: "session",
    });
  }

  /**
   * Records a user utterance, applying the persistence heuristic. Always
   * added to session memory; persisted to JARVIS/MEMORY/*.md only when the
   * heuristic (or an explicit category override) says so.
   */
  async recordUtterance(utterance: string, forceCategory?: MemoryCategory): Promise<MemoryFact | undefined> {
    this.session.addTurn({ role: "user", content: utterance });

    const decision = forceCategory
      ? { persist: true as const, category: forceCategory, reason: "explicit-category-override" }
      : shouldPersist(utterance);

    if (!decision.persist || !decision.category) return undefined;

    const fact: MemoryFact = {
      category: decision.category,
      date: new Date().toISOString().slice(0, 10),
      text: utterance,
      provenance: decision.reason,
    };
    await this.permanent.save(fact);
    logger.info("Persisted fact to permanent memory", { category: fact.category, reason: decision.reason });
    return fact;
  }
}
