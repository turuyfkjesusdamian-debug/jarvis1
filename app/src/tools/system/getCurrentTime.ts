import { z } from "zod";
import type { Tool } from "../types.js";

const paramsSchema = z.object({});

export interface CurrentTimeResult {
  iso: string;
  date: string;
  time: string;
  dayOfWeek: string;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const getCurrentTime: Tool<z.infer<typeof paramsSchema>, CurrentTimeResult> = {
  name: "system.getCurrentTime",
  description: "Get the current date, time, and day of week, for grounding time-relative requests.",
  permission: "read",
  parametersSchema: paramsSchema,
  async run() {
    const now = new Date();
    return {
      ok: true,
      data: {
        iso: now.toISOString(),
        date: now.toISOString().slice(0, 10),
        time: now.toISOString().slice(11, 19),
        dayOfWeek: DAYS[now.getUTCDay()] ?? "",
      },
    };
  },
};
