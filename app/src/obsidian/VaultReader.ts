import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";

export interface ReadNoteResult {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
  /** Content narrowed to a requested section heading, if any and found. */
  section?: string;
}

/**
 * Resolves a vault-relative path safely (no traversal outside the vault)
 * and reads note content on demand. Never used to load the whole vault at
 * once — callers should already know which path(s) they need, typically
 * from the index (see obsidian/retrieval.ts).
 */
export class VaultReader {
  constructor(private readonly vaultPath: string) {}

  /** Resolves a vault-relative path and guarantees it stays inside the vault. */
  resolve(relPath: string): string {
    const full = path.resolve(this.vaultPath, relPath);
    const normalizedRoot = path.resolve(this.vaultPath) + path.sep;
    if (!full.startsWith(normalizedRoot) && full !== path.resolve(this.vaultPath)) {
      throw new Error(`Path escapes vault root: ${relPath}`);
    }
    return full;
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(relPath));
      return true;
    } catch {
      return false;
    }
  }

  async readNote(relPath: string, sectionHeading?: string): Promise<ReadNoteResult> {
    const full = this.resolve(relPath);
    const raw = await fs.readFile(full, "utf8");
    const parsed = matter(raw);

    if (!sectionHeading) {
      return { path: relPath, frontmatter: parsed.data, content: parsed.content };
    }

    const section = extractSection(parsed.content, sectionHeading);
    return { path: relPath, frontmatter: parsed.data, content: parsed.content, section };
  }

  async writeNote(relPath: string, content: string, frontmatter?: Record<string, unknown>): Promise<void> {
    const full = this.resolve(relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    const body = frontmatter && Object.keys(frontmatter).length > 0
      ? matter.stringify(content, frontmatter)
      : content;
    await fs.writeFile(full, body, "utf8");
  }

  async appendToNote(relPath: string, text: string): Promise<void> {
    const full = this.resolve(relPath);
    const raw = await fs.readFile(full, "utf8").catch(() => "");
    const needsNewline = raw.length > 0 && !raw.endsWith("\n");
    await fs.writeFile(full, raw + (needsNewline ? "\n" : "") + text + "\n", "utf8");
  }
}

/** Extracts the body of a `## Heading` section (up to the next heading of equal/lesser depth). */
export function extractSection(content: string, heading: string): string | undefined {
  const lines = content.split("\n");
  const headingRe = /^(#+)\s+(.*)$/;
  let startIdx = -1;
  let startDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = headingRe.exec(lines[i] ?? "");
    if (m && m[2]?.trim().toLowerCase() === heading.trim().toLowerCase()) {
      startIdx = i;
      startDepth = m[1]?.length ?? 1;
      break;
    }
  }
  if (startIdx === -1) return undefined;

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = headingRe.exec(lines[i] ?? "");
    if (m && (m[1]?.length ?? 1) <= startDepth) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n").trim();
}
