#!/usr/bin/env node
// Thin CLI entry — implementation in runtime/evolve/dual-research.js
export { runResearch } from "../runtime/evolve/dual-research.js";
import { runResearch } from "../runtime/evolve/dual-research.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

if (realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const project = args[0];
  const task = args[1];
  if (!project || !task) {
    console.error("Usage: dual-research.mjs <project> '<task>'");
    process.exit(1);
  }
  const executorRoot = path.resolve(process.env.CPB_EXECUTOR_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const cpbRoot = path.resolve(process.env.CPB_ROOT || executorRoot);
  runResearch({ project, task, executorRoot, cpbRoot });
}
