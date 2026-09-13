import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import { JarvisCore } from "../core/JarvisCore.js";
import { realtimeRouter } from "./routes/realtime.js";
import { toolsRouter } from "./routes/tools.js";
import { chatRouter } from "./routes/chat.js";
import { statusRouter } from "./routes/status.js";

const srcDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(srcDir, "..", "public");

export async function createApp(vaultPath: string): Promise<{ app: Express; core: JarvisCore }> {
  const core = new JarvisCore(vaultPath);
  await core.init();

  const app = express();
  app.use(express.json());
  app.use(express.static(publicDir));

  app.use("/api/realtime", realtimeRouter(core));
  app.use("/api/tools", toolsRouter(core));
  app.use("/api/chat", chatRouter(core));
  app.use("/api/status", statusRouter(core));

  return { app, core };
}
