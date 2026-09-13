import { VaultReader } from "../obsidian/VaultReader.js";

export type MemoryCategory = "user" | "preferences" | "projects" | "people" | "important-facts";

export const MEMORY_CATEGORIES: MemoryCategory[] = [
  "user",
  "preferences",
  "projects",
  "people",
  "important-facts",
];

function pathFor(category: MemoryCategory): string {
  return `JARVIS/MEMORY/${category}.md`;
}

export interface MemoryFact {
  category: MemoryCategory;
  date: string;
  text: string;
  provenance?: string;
}

function renderLine(fact: Omit<MemoryFact, "category">): string {
  return `- ${fact.date}: ${fact.text}${fact.provenance ? ` (${fact.provenance})` : ""}`;
}

function parseFacts(content: string): { text: string; date: string; provenance?: string }[] {
  const facts: { text: string; date: string; provenance?: string }[] = [];
  const lineRe = /^-\s+(\d{4}-\d{2}-\d{2}):\s+(.*)$/;
  for (const line of content.split("\n")) {
    const m = lineRe.exec(line.trim());
    if (!m) continue;
    const date = m[1] ?? "";
    let text = m[2] ?? "";
    let provenance: string | undefined;
    const provMatch = /\s+\(([^()]*)\)$/.exec(text);
    if (provMatch) {
      provenance = provMatch[1];
      text = text.slice(0, provMatch.index).trim();
    }
    facts.push({ date, text, provenance });
  }
  return facts;
}

/**
 * Permanent (durable) memory: JARVIS/MEMORY/*.md, one bullet per fact. See
 * JARVIS/MEMORY.md for the write heuristic and category meanings.
 */
export class PermanentMemory {
  constructor(private readonly reader: VaultReader) {}

  async save(fact: MemoryFact): Promise<void> {
    const relPath = pathFor(fact.category);
    const exists = await this.reader.exists(relPath);
    if (!exists) {
      await this.reader.writeNote(
        relPath,
        `# ${fact.category}\n\n${renderLine(fact)}\n`,
        { type: "memory", category: fact.category }
      );
      return;
    }
    await this.reader.appendToNote(relPath, renderLine(fact));
  }

  async list(category: MemoryCategory): Promise<MemoryFact[]> {
    const relPath = pathFor(category);
    if (!(await this.reader.exists(relPath))) return [];
    const note = await this.reader.readNote(relPath);
    return parseFacts(note.content).map((f) => ({ ...f, category }));
  }

  async listAll(): Promise<MemoryFact[]> {
    const all = await Promise.all(MEMORY_CATEGORIES.map((c) => this.list(c)));
    return all.flat();
  }

  /**
   * Matches facts containing any word of the query (OR semantics), scored
   * by how many words matched — a single-string exact-substring match
   * would almost never hit for natural-language questions like "what do
   * you remember about the project?" against a fact phrased differently.
   */
  async search(query: string): Promise<MemoryFact[]> {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    if (words.length === 0) return [];

    const all = await this.listAll();
    const scored = all
      .map((f) => {
        const text = f.text.toLowerCase();
        const score = words.filter((w) => text.includes(w)).length;
        return { fact: f, score };
      })
      .filter((s) => s.score > 0);

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.fact);
  }

  /** Removes the first fact whose text matches (case-insensitive substring). Returns true if removed. */
  async forget(category: MemoryCategory, textMatch: string): Promise<boolean> {
    const relPath = pathFor(category);
    if (!(await this.reader.exists(relPath))) return false;
    const note = await this.reader.readNote(relPath);
    const facts = parseFacts(note.content);
    const idx = facts.findIndex((f) => f.text.toLowerCase().includes(textMatch.toLowerCase()));
    if (idx === -1) return false;
    facts.splice(idx, 1);
    const body = `# ${category}\n\n${facts.length ? facts.map((f) => renderLine(f)).join("\n") + "\n" : "(no facts recorded)\n"}`;
    await this.reader.writeNote(relPath, body, note.frontmatter);
    return true;
  }
}
