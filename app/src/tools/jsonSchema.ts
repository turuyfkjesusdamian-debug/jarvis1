import { z } from "zod";

/**
 * Minimal Zod → JSON Schema converter, sufficient for this project's own
 * tool parameter shapes (object/string/number/boolean/array/enum/
 * optional/default/record). Not a general-purpose converter — if a future
 * tool needs a shape this doesn't handle, extend it deliberately rather
 * than pulling in a dependency for one feature.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def;

  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return zodToJsonSchema(def.innerType);
  }
  if (schema instanceof z.ZodString) {
    return { type: "string" };
  }
  if (schema instanceof z.ZodNumber) {
    return { type: "number" };
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: def.values };
  }
  if (schema instanceof z.ZodArray) {
    return { type: "array", items: zodToJsonSchema(def.type) };
  }
  if (schema instanceof z.ZodRecord) {
    return { type: "object", additionalProperties: true };
  }
  if (schema instanceof z.ZodObject) {
    const shape = def.shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      const fieldSchema = value as z.ZodTypeAny;
      properties[key] = zodToJsonSchema(fieldSchema);
      if (!(fieldSchema instanceof z.ZodOptional) && !(fieldSchema instanceof z.ZodDefault)) {
        required.push(key);
      }
    }
    return { type: "object", properties, required, additionalProperties: false };
  }

  return {};
}
