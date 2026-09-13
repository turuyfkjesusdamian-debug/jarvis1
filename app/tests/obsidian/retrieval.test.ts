import { describe, it, expect } from "vitest";
import { retrieve } from "../../src/obsidian/retrieval.js";
import type { VaultIndex } from "../../src/obsidian/types.js";

const now = Date.now();

function makeIndex(): VaultIndex {
  return {
    generatedAt: new Date().toISOString(),
    vaultPath: "/vault",
    files: [
      {
        path: "Projects/apollo.md",
        title: "Project Apollo",
        tags: ["project", "active"],
        frontmatter: { status: "active" },
        links: [],
        mtimeMs: now,
        sizeBytes: 100,
      },
      {
        path: "Notes/random.md",
        title: "Random musings",
        tags: ["misc"],
        frontmatter: {},
        links: [],
        mtimeMs: now - 1000 * 60 * 60 * 24 * 60,
        sizeBytes: 100,
      },
      {
        path: "Tasks/tasks.md",
        title: "Tasks",
        tags: ["tasks"],
        frontmatter: {},
        links: [],
        mtimeMs: now,
        sizeBytes: 100,
      },
    ],
  };
}

describe("retrieve", () => {
  it("returns nothing when no filters at all are given", () => {
    const matches = retrieve(makeIndex(), {});
    expect(matches).toEqual([]);
  });

  it("filters by folder", () => {
    const matches = retrieve(makeIndex(), { folders: ["Tasks"] });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.entry.path).toBe("Tasks/tasks.md");
  });

  it("filters by tag", () => {
    const matches = retrieve(makeIndex(), { tags: ["project"] });
    expect(matches.map((m) => m.entry.path)).toEqual(["Projects/apollo.md"]);
  });

  it("filters by frontmatter", () => {
    const matches = retrieve(makeIndex(), { frontmatter: { status: "active" } });
    expect(matches.map((m) => m.entry.path)).toEqual(["Projects/apollo.md"]);
  });

  it("scores keyword matches and excludes non-matches", () => {
    const matches = retrieve(makeIndex(), { keywords: ["apollo"] });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.entry.path).toBe("Projects/apollo.md");
  });

  it("boosts more recently modified files when scores otherwise tie", () => {
    const matches = retrieve(makeIndex(), { tags: ["project", "misc"] });
    const paths = matches.map((m) => m.entry.path);
    expect(paths[0]).toBe("Projects/apollo.md");
  });

  it("respects the limit option", () => {
    const matches = retrieve(makeIndex(), { keywords: ["a"], limit: 1 });
    expect(matches.length).toBeLessThanOrEqual(1);
  });
});
