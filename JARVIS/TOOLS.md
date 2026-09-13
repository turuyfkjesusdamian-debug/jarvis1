# TOOLS.md

Tools are the only way JARVIS acts on the world. The model never gets raw
filesystem or shell access — every action is an explicit, schema-validated,
logged tool call.

## Tool anatomy

Every tool (`app/src/tools/**/*.ts`) exports a single object matching
`Tool` from `app/src/tools/types.ts`:

```ts
interface Tool<Params, Result> {
  name: string;                 // unique, e.g. "obsidian.searchNotes"
  description: string;          // sent to the model verbatim
  parametersSchema: z.ZodType<Params>;
  permission: "read" | "write" | "destructive";
  run: (params: Params, ctx: ToolContext) => Promise<ToolResult<Result>>;
}
```

- **`parametersSchema`** — a `zod` schema. The registry rejects any call
  that fails validation before `run` ever executes.
- **`permission`** — `"read"` runs freely; `"write"` runs freely but is
  logged prominently; `"destructive"` (delete/overwrite/external send)
  requires explicit user confirmation surfaced by `core` before `run` is
  invoked (see `JARVIS/SECURITY.md`).
- **`run`** — the implementation. Must not throw for expected failure
  modes (e.g. "note not found") — return a structured error result
  instead. Only truly unexpected errors should throw, and the registry
  catches those and turns them into a structured error result anyway.
- **Result** — always `{ ok: true, data } | { ok: false, error }`, JSON
  serializable, no secrets.

## Current tool groups

### `obsidian/` (vault access)
- `searchNotes` — query the index (tags/folder/frontmatter/keyword),
  returns matching file paths + short excerpts. Read.
- `readNote` — read one note (optionally a specific section). Read.
- `createNote` — create a new note with frontmatter. Write.
- `updateNote` — replace a note's content or frontmatter. Write.
- `appendToNote` — append a section/bullet to an existing note. Write.

### `tasks/` (task management, stored as Markdown checklists under `Tasks/`)
- `listTasks` — list open/all tasks, optionally filtered by project/date.
  Read.
- `createTask` — add a task (as a `- [ ]` line, with optional due date in
  frontmatter-like inline tags). Write.
- `completeTask` — mark a task done (`- [x]`). Write.
- `updateTask` — edit a task's text/date/project. Write.

### `memory/` (permanent memory, see `JARVIS/MEMORY.md`)
- `searchMemory` — search across `JARVIS/MEMORY/*.md`. Read.
- `saveMemory` — append a fact to the right category file. Write.
- `forgetMemory` — remove a specific remembered fact. Destructive
  (requires confirmation).

### `system/`
- `getCurrentTime` — current date/time (and day-of-week), for grounding.
  Read.
- `getSystemStatus` — app health (vault index freshness, memory tier
  sizes, last error). Read.

## Adding a new tool

1. Create `app/src/tools/<group>/<toolName>.ts` implementing the `Tool`
   interface above. Reuse `obsidian/` or `memory/` modules — don't touch
   the filesystem directly from a tool.
2. Register it in `app/src/tools/registry.ts`.
3. Add a row to the table above.
4. Add a unit test under `app/tests/tools/`.
5. If the tool is `"destructive"`, confirm the confirmation flow is wired
   in `core/toolRouter.ts` (it is, by permission level — no per-tool
   special-casing needed unless the tool has unusual semantics).

## Future tool groups (designed for, not built)

Calendar, email, weather, web search, desktop notifications, device
control. Each becomes its own folder under `tools/` with the same anatomy
— no core changes required to add them.
