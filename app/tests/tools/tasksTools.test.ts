import { describe, it, expect, afterEach } from "vitest";
import { listTasks } from "../../src/tools/tasks/listTasks.js";
import { createTask } from "../../src/tools/tasks/createTask.js";
import { completeTask } from "../../src/tools/tasks/completeTask.js";
import { updateTask } from "../../src/tools/tasks/updateTask.js";
import { createTempVault, buildToolContext } from "../testUtils.js";

describe("tasks tools", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("listTasks excludes completed tasks by default", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const result = await listTasks.run({ includeCompleted: false }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.some((t) => t.text.includes("Send invoice"))).toBe(false);
      expect(result.data.some((t) => t.text.includes("Buy groceries"))).toBe(true);
    }
  });

  it("listTasks can include completed tasks", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const result = await listTasks.run({ includeCompleted: true }, ctx);
    if (result.ok) {
      expect(result.data.some((t) => t.text.includes("Send invoice"))).toBe(true);
    }
  });

  it("createTask appends to the default tasks file and is visible to listTasks", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const created = await createTask.run({ text: "New task", project: "apollo" }, ctx);
    expect(created.ok).toBe(true);

    const listed = await listTasks.run({}, ctx);
    if (listed.ok) {
      expect(listed.data.some((t) => t.text.includes("New task"))).toBe(true);
    }
  });

  it("completeTask marks the matching task done", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const result = await completeTask.run({ matchText: "groceries" }, ctx);
    expect(result.ok).toBe(true);

    const listed = await listTasks.run({ includeCompleted: false }, ctx);
    if (listed.ok) {
      expect(listed.data.some((t) => t.text.includes("Buy groceries"))).toBe(false);
    }
  });

  it("completeTask fails cleanly when nothing matches", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const result = await completeTask.run({ matchText: "does not exist anywhere" }, ctx);
    expect(result.ok).toBe(false);
  });

  it("updateTask edits an existing task's due date", async () => {
    const vault = await createTempVault();
    cleanup = vault.cleanup;
    const ctx = buildToolContext(vault.vaultPath);

    const result = await updateTask.run({ matchText: "Apollo report", newDue: "2026-12-01" }, ctx);
    expect(result.ok).toBe(true);

    const listed = await listTasks.run({}, ctx);
    if (listed.ok) {
      const task = listed.data.find((t) => t.text.includes("Apollo report"));
      expect(task?.due).toBe("2026-12-01");
    }
  });
});
