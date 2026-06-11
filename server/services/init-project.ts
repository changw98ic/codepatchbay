#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../../cli/commands/init.js";

const executorRoot = path.resolve(
  process.env.CPB_EXECUTOR_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
);
const cpbRoot = path.resolve(process.env.CPB_ROOT || executorRoot);

try {
  await initProject(process.argv.slice(2), { cpbRoot, executorRoot });
} catch (error: any) {
  console.error(error.message);
  process.exitCode = 1;
}
