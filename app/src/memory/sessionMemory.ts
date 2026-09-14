export interface SessionTurn {
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
  at: string;
}

/**
 * In-process, volatile conversation memory. Never persisted as a source of
 * truth (see JARVIS/MEMORY.md § Session memory) — only mirrored to
 * JARVIS/STATE/current-session.md for inspection/debugging.
 */
export class SessionMemory {
  private turns: SessionTurn[] = [];
  private readonly maxTurns: number;

  constructor(maxTurns = 40) {
    this.maxTurns = maxTurns;
  }

  addTurn(turn: Omit<SessionTurn, "at">): void {
    this.turns.push({ ...turn, at: new Date().toISOString() });
    if (this.turns.length > this.maxTurns) {
      this.turns.splice(0, this.turns.length - this.maxTurns);
    }
  }

  getRecent(count = 10): SessionTurn[] {
    return this.turns.slice(-count);
  }

  clear(): void {
    this.turns = [];
  }

  /** Replaces the in-memory turns with previously persisted ones (see MemoryEngine.loadPersistedSession). */
  restore(turns: SessionTurn[]): void {
    this.turns = turns.slice(-this.maxTurns);
  }

  /** Plain-data snapshot for persistence — see MemoryEngine.flushSessionToDisk. */
  toJSON(): SessionTurn[] {
    return this.turns;
  }

  renderForFile(): string {
    if (this.turns.length === 0) return "No active session.";
    return this.turns
      .map((t) => `- [${t.at}] **${t.role}${t.toolName ? `:${t.toolName}` : ""}** ${t.content}`)
      .join("\n");
  }
}
