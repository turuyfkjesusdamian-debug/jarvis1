import type { z } from "zod";
import type { VaultReader } from "../obsidian/VaultReader.js";
import type { VaultIndex } from "../obsidian/types.js";
import type { MemoryEngine } from "../memory/MemoryEngine.js";

export type ToolPermission = "read" | "write" | "destructive";

export interface ToolContext {
  vaultReader: VaultReader;
  /** Returns the current vault index, rebuilding it if it's missing (cached by the caller). */
  getIndex: () => Promise<VaultIndex>;
  memory: MemoryEngine;
  /**
   * Set by core only, only after the user explicitly confirmed a
   * destructive action in the current turn. See JARVIS/SECURITY.md.
   */
  confirmed?: boolean;
}

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface Tool<Params = unknown, Result = unknown> {
  name: string;
  description: string;
  permission: ToolPermission;
  parametersSchema: z.ZodType<Params, z.ZodTypeDef, any>;
  run: (params: Params, ctx: ToolContext) => Promise<ToolResult<Result>>;
}

/** Narrows a Tool's generic params for storage in a heterogeneous registry map. */
export type AnyTool = Tool<any, any>;
