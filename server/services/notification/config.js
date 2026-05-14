import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadConfig(flowRoot) {
  const file = path.join(flowRoot, "channels.json");
  try {
    const raw = await readFile(file, "utf8");
    const config = JSON.parse(raw);
    if (!config || typeof config !== "object") return null;
    return config;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    console.error(`[notification] config load error: ${err.message}`);
    return null;
  }
}
