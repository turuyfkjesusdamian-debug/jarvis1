import { VaultReader } from "../obsidian/VaultReader.js";

const CURRENT_DAY_PATH = "JARVIS/STATE/current-day.md";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Short-term (daily) memory: JARVIS/STATE/current-day.md. Rotated when the
 * stored date no longer matches today (see JARVIS/MEMORY.md § Short-term
 * memory).
 */
export class ShortTermMemory {
  constructor(private readonly reader: VaultReader) {}

  private render(date: string, goals: string[], notes: string[]): string {
    const goalsBlock = goals.length ? goals.map((g) => `- ${g}`).join("\n") : "(none yet)";
    const notesBlock = notes.length ? notes.map((n) => `- ${n}`).join("\n") : "(none yet)";
    return `# Today\n\n## Goals\n\n${goalsBlock}\n\n## Notes\n\n${notesBlock}\n`;
  }

  private parse(content: string): { goals: string[]; notes: string[] } {
    const section = (heading: string): string[] => {
      const re = new RegExp(`##\\s+${heading}\\n([\\s\\S]*?)(?=\\n##|$)`, "i");
      const match = re.exec(content);
      if (!match?.[1]) return [];
      return match[1]
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- ") && l !== "- (none yet)")
        .map((l) => l.slice(2).trim());
    };
    return { goals: section("Goals"), notes: section("Notes") };
  }

  /** Ensures today's file exists and matches today's date; rotates otherwise. */
  async ensureFresh(): Promise<void> {
    const exists = await this.reader.exists(CURRENT_DAY_PATH);
    const today = todayIso();
    if (!exists) {
      await this.reader.writeNote(CURRENT_DAY_PATH, this.render(today, [], []), {
        type: "state",
        scope: "day",
        date: today,
      });
      return;
    }
    const note = await this.reader.readNote(CURRENT_DAY_PATH);
    if (note.frontmatter.date !== today) {
      await this.reader.writeNote(CURRENT_DAY_PATH, this.render(today, [], []), {
        type: "state",
        scope: "day",
        date: today,
      });
    }
  }

  async addGoal(goal: string): Promise<void> {
    await this.ensureFresh();
    const note = await this.reader.readNote(CURRENT_DAY_PATH);
    const { goals, notes } = this.parse(note.content);
    goals.push(goal);
    await this.reader.writeNote(CURRENT_DAY_PATH, this.render(todayIso(), goals, notes), note.frontmatter);
  }

  async addNote(text: string): Promise<void> {
    await this.ensureFresh();
    const note = await this.reader.readNote(CURRENT_DAY_PATH);
    const { goals, notes } = this.parse(note.content);
    notes.push(text);
    await this.reader.writeNote(CURRENT_DAY_PATH, this.render(todayIso(), goals, notes), note.frontmatter);
  }

  async read(): Promise<{ date: string; goals: string[]; notes: string[] }> {
    await this.ensureFresh();
    const note = await this.reader.readNote(CURRENT_DAY_PATH);
    return { date: todayIso(), ...this.parse(note.content) };
  }
}
