import { describe, it, expect } from "vitest";
import { shouldPersist } from "../../src/memory/shouldPersist.js";

describe("shouldPersist", () => {
  it("persists explicit remember requests to important-facts", () => {
    expect(shouldPersist("Remember that this project matters to me.")).toMatchObject({
      persist: true,
      category: "important-facts",
    });
    expect(shouldPersist("Recuérdame que el proyecto es importante.")).toMatchObject({
      persist: true,
      category: "important-facts",
    });
  });

  it("persists stable preference statements to preferences", () => {
    expect(shouldPersist("I always want summaries, not full text.")).toMatchObject({
      persist: true,
      category: "preferences",
    });
  });

  it("persists project mentions to projects", () => {
    expect(shouldPersist("The Apollo project is due next month.")).toMatchObject({
      persist: true,
      category: "projects",
    });
  });

  it("persists relationship facts to people", () => {
    expect(shouldPersist("My boss wants a report on Friday.")).toMatchObject({
      persist: true,
      category: "people",
    });
  });

  it("does not persist ordinary questions", () => {
    expect(shouldPersist("What time is it?")).toMatchObject({ persist: false });
  });

  it("does not persist a question just because it mentions a project or person", () => {
    // Regression: "¿qué recuerdas sobre el proyecto?" used to get saved to
    // projects.md as if it were a fact, because it matched PROJECT_PATTERNS.
    expect(shouldPersist("¿Qué recuerdas sobre el proyecto?")).toMatchObject({ persist: false });
    expect(shouldPersist("What do you know about my boss?")).toMatchObject({ persist: false });
  });

  it("explicit instruction wins even if a project is also mentioned", () => {
    const decision = shouldPersist("Remember that the Apollo project deadline moved.");
    expect(decision.category).toBe("important-facts");
  });
});
