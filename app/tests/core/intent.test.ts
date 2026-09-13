import { describe, it, expect } from "vitest";
import { classifyIntent } from "../../src/core/intent.js";

describe("classifyIntent", () => {
  it("classifies schedule questions", () => {
    expect(classifyIntent("¿Qué tengo hoy?")).toBe("schedule");
    expect(classifyIntent("What's on my schedule today?")).toBe("schedule");
  });

  it("classifies task questions", () => {
    expect(classifyIntent("¿Qué tareas pendientes tengo?")).toBe("tasks");
    expect(classifyIntent("Add a new task")).toBe("tasks");
  });

  it("classifies memory save requests", () => {
    expect(classifyIntent("Recuérdame que esto es importante")).toBe("memory");
    expect(classifyIntent("Remember this for later")).toBe("memory");
  });

  it("classifies memory recall questions, not just save instructions", () => {
    expect(classifyIntent("¿Qué recuerdas sobre el proyecto?")).toBe("memory");
    expect(classifyIntent("Do you remember what I told you about Ada?")).toBe("memory");
  });

  it("classifies note/vault questions", () => {
    expect(classifyIntent("Busca la nota sobre Apollo")).toBe("notes");
  });

  it("falls back to general for everything else", () => {
    expect(classifyIntent("Tell me a joke")).toBe("general");
  });
});
