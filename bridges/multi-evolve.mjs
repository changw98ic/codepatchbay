#!/usr/bin/env node
// Thin CLI entry — implementation in runtime/evolve/multi-evolve.js
export { parseScanResults, CrossProjectPriorityQueue, MultiEvolveController } from "../runtime/evolve/multi-evolve.js";
import { main } from "../runtime/evolve/multi-evolve.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = await main();
}
