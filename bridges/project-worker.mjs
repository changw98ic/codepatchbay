#!/usr/bin/env node
// Thin CLI entry — implementation in runtime/worker/project-worker.js
export { AGENT_OUTAGE_EXIT_CODE, ProjectWorker, parseArgs } from "../runtime/worker/project-worker.js";
import { main } from "../runtime/worker/project-worker.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
