import { describe, it, expect } from "vitest";
import { parseTaskLines, formatTaskLine, replaceLine } from "../../src/tools/tasks/taskLines.js";

describe("taskLines", () => {
  it("parses open, done, project, and due-date tasks", () => {
    const content = [
      "# Tasks",
      "",
      "- [ ] Finish the Apollo report #project-apollo due:2026-09-14",
      "- [ ] Buy groceries",
      "- [x] Send invoice",
      "Not a task line",
    ].join("\n");

    const tasks = parseTaskLines(content);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({ done: false, text: "Finish the Apollo report", project: "project-apollo", due: "2026-09-14" });
    expect(tasks[1]).toMatchObject({ done: false, project: undefined, due: undefined });
    expect(tasks[2]).toMatchObject({ done: true });
  });

  it("formats a task line round-trippably, without tags leaking into text", () => {
    const line = formatTaskLine("Do the thing", "proj", "2026-01-01", false);
    expect(line).toBe("- [ ] Do the thing #proj due:2026-01-01");
    const [parsed] = parseTaskLines(line);
    expect(parsed).toMatchObject({ text: "Do the thing", project: "proj", due: "2026-01-01" });
  });

  it("replaceLine swaps only the targeted line", () => {
    const content = "line0\nline1\nline2";
    expect(replaceLine(content, 1, "REPLACED")).toBe("line0\nREPLACED\nline2");
  });
});
