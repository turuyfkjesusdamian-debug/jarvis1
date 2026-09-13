import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { logger } from "../logging/logger.js";
import type { NoteIndexEntry, VaultIndex } from "./types.js";

const WIKILINK_RE = /\[\[([^\]|#]+)/g;

/** Directories never scanned: app internals, VCS, editor/system metadata. */
const IGNORED_DIRS = new Set([
  "app",
  ".git",
  ".obsidian",
  "node_modules",
  "JARVIS/INDEX",
  "JARVIS/LOGS",
]);

function extractLinks(body: string): string[] {
  const links = new Set<string>();
  for (const match of body.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim();
    if (target) links.add(target);
  }
  return [...links];
}

function extractTags(frontmatter: Record<string, unknown>, body: string): string[] {
  const tags = new Set<string>();
  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) if (typeof t === "string") tags.add(t);
  } else if (typeof fmTags === "string") {
    tags.add(fmTags);
  }
  for (const match of body.matchAll(/(^|\s)#([A-Za-z0-9_/-]+)/g)) {
    const tag = match[2];
    if (tag) tags.add(tag);
  }
  return [...tags];
}

function deriveTitle(frontmatter: Record<string, unknown>, body: string, filePath: string): string {
  if (typeof frontmatter.title === "string" && frontmatter.title.trim()) {
    return frontmatter.title.trim();
  }
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim();
  return path.basename(filePath, path.extname(filePath));
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    logger.warn("Failed to read directory during indexing", { dir, error: String(err) });
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(rel) || IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      await walk(full, root, out);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
}

/**
 * Scans the vault and builds a lightweight index: metadata only, never full
 * note bodies (see JARVIS/ARCHITECTURE.md § Retrieval strategy).
 */
export class VaultIndexer {
  constructor(private readonly vaultPath: string) {}

  async buildIndex(): Promise<VaultIndex> {
    const files: string[] = [];
    await walk(this.vaultPath, this.vaultPath, files);

    const entries: NoteIndexEntry[] = [];
    for (const filePath of files) {
      try {
        const [raw, stat] = await Promise.all([
          fs.readFile(filePath, "utf8"),
          fs.stat(filePath),
        ]);
        const parsed = matter(raw);
        const frontmatter = parsed.data as Record<string, unknown>;
        const relPath = path.relative(this.vaultPath, filePath).split(path.sep).join("/");
        entries.push({
          path: relPath,
          title: deriveTitle(frontmatter, parsed.content, filePath),
          tags: extractTags(frontmatter, parsed.content),
          frontmatter,
          links: extractLinks(parsed.content),
          mtimeMs: stat.mtimeMs,
          sizeBytes: stat.size,
        });
      } catch (err) {
        logger.warn("Failed to index file, skipping", { filePath, error: String(err) });
      }
    }

    entries.sort((a, b) => a.path.localeCompare(b.path));

    return {
      generatedAt: new Date().toISOString(),
      vaultPath: this.vaultPath,
      files: entries,
    };
  }

  async writeIndex(index: VaultIndex, indexFilePath: string): Promise<void> {
    await fs.mkdir(path.dirname(indexFilePath), { recursive: true });
    await fs.writeFile(indexFilePath, JSON.stringify(index, null, 2) + "\n", "utf8");
  }

  async readIndex(indexFilePath: string): Promise<VaultIndex | undefined> {
    try {
      const raw = await fs.readFile(indexFilePath, "utf8");
      return JSON.parse(raw) as VaultIndex;
    } catch {
      return undefined;
    }
  }

  /** Builds and persists the index in one step; returns it. */
  async reindex(indexFilePath: string): Promise<VaultIndex> {
    const index = await this.buildIndex();
    await this.writeIndex(index, indexFilePath);
    logger.info("Vault reindexed", { files: index.files.length, indexFilePath });
    return index;
  }
}
