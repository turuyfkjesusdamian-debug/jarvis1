export interface ParsedTask {
  /** Line index within the note's body (0-based), for in-place edits. */
  lineIndex: number;
  done: boolean;
  text: string;
  project?: string;
  due?: string;
}

const TASK_LINE_RE = /^-\s+\[( |x|X)\]\s+(.*)$/;
const PROJECT_TAG_RE = /#([A-Za-z0-9_-]+)/;
const DUE_TAG_RE = /due:(\d{4}-\d{2}-\d{2})/;

export function parseTaskLines(content: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const lines = content.split("\n");
  lines.forEach((line, lineIndex) => {
    const m = TASK_LINE_RE.exec(line.trim());
    if (!m) return;
    const done = m[1]?.toLowerCase() === "x";
    const rest = m[2] ?? "";
    const project = PROJECT_TAG_RE.exec(rest)?.[1];
    const due = DUE_TAG_RE.exec(rest)?.[1];
    // Strip the inline tags out of the description so formatTaskLine (which
    // re-appends them from `project`/`due`) doesn't duplicate them on every
    // edit — text is the plain description only.
    const text = rest
      .replace(PROJECT_TAG_RE, "")
      .replace(DUE_TAG_RE, "")
      .replace(/\s+/g, " ")
      .trim();
    tasks.push({ lineIndex, done, text, project, due });
  });
  return tasks;
}

export function formatTaskLine(text: string, project?: string, due?: string, done = false): string {
  let line = `- [${done ? "x" : " "}] ${text}`;
  if (project) line += ` #${project}`;
  if (due) line += ` due:${due}`;
  return line;
}

/** Replaces one line (by index) in a note body, returning the new body. */
export function replaceLine(content: string, lineIndex: number, newLine: string): string {
  const lines = content.split("\n");
  lines[lineIndex] = newLine;
  return lines.join("\n");
}
