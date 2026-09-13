import type { NoteIndexEntry, VaultIndex } from "./types.js";

export interface RetrievalQuery {
  /** Free-text keywords, matched against title/tags/path/frontmatter values. */
  keywords?: string[];
  /** Restrict to files whose path starts with one of these folders. */
  folders?: string[];
  /** Restrict to files carrying at least one of these tags. */
  tags?: string[];
  /** Restrict to files whose frontmatter[key] === value. */
  frontmatter?: Record<string, unknown>;
  /** Max results to return, most relevant first. Default 10. */
  limit?: number;
}

export interface RetrievalMatch {
  entry: NoteIndexEntry;
  score: number;
  reasons: string[];
}

function normalize(s: string): string {
  return s.toLowerCase();
}

/**
 * Scores every indexed file against a query using folder/tag/frontmatter/
 * keyword/recency signals. No embeddings, no model call — see
 * JARVIS/ARCHITECTURE.md § Retrieval strategy for why this is deliberate.
 */
export function retrieve(index: VaultIndex, query: RetrievalQuery): RetrievalMatch[] {
  const limit = query.limit ?? 10;
  const keywords = (query.keywords ?? []).map(normalize).filter(Boolean);

  const matches: RetrievalMatch[] = [];

  for (const entry of index.files) {
    let score = 0;
    const reasons: string[] = [];

    if (query.folders?.length) {
      const folderHit = query.folders.some((f) => entry.path.startsWith(f.replace(/\/$/, "") + "/"));
      if (!folderHit) continue;
      score += 3;
      reasons.push("folder");
    }

    if (query.tags?.length) {
      const tagHit = query.tags.some((t) => entry.tags.includes(t));
      if (!tagHit) continue;
      score += 3;
      reasons.push("tag");
    }

    if (query.frontmatter) {
      const fmEntries = Object.entries(query.frontmatter);
      const fmHit = fmEntries.every(([k, v]) => entry.frontmatter[k] === v);
      if (fmEntries.length > 0) {
        if (!fmHit) continue;
        score += 3;
        reasons.push("frontmatter");
      }
    }

    if (keywords.length) {
      const haystack = normalize(
        [entry.title, entry.path, entry.tags.join(" "), JSON.stringify(entry.frontmatter)].join(" ")
      );
      const hitCount = keywords.filter((k) => haystack.includes(k)).length;
      if (hitCount === 0 && (query.folders?.length || query.tags?.length || query.frontmatter)) {
        // Structural filters already matched; keyword absence just doesn't add score.
      } else if (hitCount === 0) {
        continue;
      } else {
        score += hitCount * 2;
        reasons.push("keyword");
      }
    }

    // No filters at all: nothing to shortlist by relevance beyond recency.
    if (!query.folders?.length && !query.tags?.length && !query.frontmatter && keywords.length === 0) {
      continue;
    }

    // Recency: small boost for recently modified files, most relevant when scores tie.
    const ageDays = (Date.now() - entry.mtimeMs) / (1000 * 60 * 60 * 24);
    score += Math.max(0, 1 - ageDays / 30);

    matches.push({ entry, score, reasons });
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, limit);
}
