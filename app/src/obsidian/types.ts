export interface NoteIndexEntry {
  /** Path relative to the vault root, forward-slash separated. */
  path: string;
  title: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  /** Wiki-links ([[Target]]) found in the body, as written (not resolved). */
  links: string[];
  mtimeMs: number;
  /** Byte size, used to decide whether to read a note in full vs. by section. */
  sizeBytes: number;
}

export interface VaultIndex {
  generatedAt: string;
  vaultPath: string;
  files: NoteIndexEntry[];
}
