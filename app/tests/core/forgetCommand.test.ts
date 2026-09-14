import { describe, it, expect } from "vitest";
import { parseForgetCommand, isAffirmative } from "../../src/core/forgetCommand.js";

describe("parseForgetCommand", () => {
  it("extracts the target from 'olvida X'", () => {
    expect(parseForgetCommand("olvida el proyecto Apollo")).toBe("el proyecto Apollo");
  });

  it("extracts the target from 'olvídate de X'", () => {
    expect(parseForgetCommand("olvídate de mi cumpleaños")).toBe("mi cumpleaños");
  });

  it("extracts the target from 'olvida que X'", () => {
    expect(parseForgetCommand("olvida que tengo una cita el lunes")).toBe("tengo una cita el lunes");
  });

  it("strips trailing punctuation", () => {
    expect(parseForgetCommand("olvida el café.")).toBe("el café");
  });

  it("does not match 'no olvides X' (the opposite instruction — remember)", () => {
    expect(parseForgetCommand("no olvides mi cumpleaños")).toBeUndefined();
  });

  it("does not match unrelated utterances", () => {
    expect(parseForgetCommand("¿qué recuerdas sobre el proyecto?")).toBeUndefined();
  });
});

describe("isAffirmative", () => {
  it("accepts sí/si with or without accents", () => {
    expect(isAffirmative("sí")).toBe(true);
    expect(isAffirmative("si")).toBe(true);
    expect(isAffirmative("Sí, confirmo")).toBe(true);
  });

  it("treats anything else as no, including ambiguous replies", () => {
    expect(isAffirmative("no")).toBe(false);
    expect(isAffirmative("no lo sé")).toBe(false);
    expect(isAffirmative("tal vez")).toBe(false);
    expect(isAffirmative("")).toBe(false);
  });
});
