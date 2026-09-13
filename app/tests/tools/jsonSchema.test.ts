import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodToJsonSchema } from "../../src/tools/jsonSchema.js";

describe("zodToJsonSchema", () => {
  it("converts a representative tool parameter object", () => {
    const schema = z.object({
      text: z.string(),
      count: z.number().optional(),
      done: z.boolean().default(false),
      tags: z.array(z.string()).optional(),
      category: z.enum(["a", "b"]),
    });

    const json = zodToJsonSchema(schema) as any;
    expect(json.type).toBe("object");
    expect(json.properties.text).toEqual({ type: "string" });
    expect(json.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(json.properties.category).toEqual({ type: "string", enum: ["a", "b"] });
    expect(json.required).toContain("text");
    expect(json.required).toContain("category");
    expect(json.required).not.toContain("count");
    expect(json.required).not.toContain("done");
  });
});
