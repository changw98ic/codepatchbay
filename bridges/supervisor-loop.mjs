#!/usr/bin/env node
import path from "node:path";
import { recoverAndRun } from "../server/services/supervisor.js";
import { resolveExecutorRoot } from "../server/services/executor-root.js";

const cpbRoot = path.resolve(
  process.env.CPB_ROOT || path.join(import.meta.dirname, "..")
);
const executorRoot = resolveExecutorRoot({
  fallbackRoot: path.join(import.meta.dirname, ".."),
});
const intervalMs = Number(
  process.env.CPB_SUPERVISOR_INTERVAL_MS || 30_000
);
const maxConcurrent = Number(
  process.env.CPB_SUPERVISOR_MAX_CONCURRENT || 1
);

function log(tag, message) {
  console.log(`${new Date().toISOString()} [${tag}] ${message}`);
}

async function tick() {
  log("tick", "scanning for recoverable jobs");

  let results;
  try {
    results = await recoverAndRun(cpbRoot, { maxConcurrent, executorRoot });
  } catch (err) {
    log("error", `recovery scan failed: ${err.message}`);
    return;
  }

  if (results.length === 0) {
    log("tick", "no recoverable jobs");
    return;
  }

  for (const result of results) {
    const { jobId, project, phase, exitCode, error } = result;
    if (error) {
      log("error", `${project}/${jobId} phase=${phase} exit=${exitCode} err=${error}`);
    } else {
      log("recovered", `${project}/${jobId} phase=${phase} exit=${exitCode}`);
    }
  }
}

// Recursive setTimeout to prevent overlapping ticks.
let tickInFlight = false;

async function guardedTick() {
  if (tickInFlight) {
    log("warn", "previous tick still in progress, skipping");
    return;
  }
  tickInFlight = true;
  try {
    await tick();
  } catch (err) {
    log("error", `tick crashed: ${err.message}`);
  } finally {
    tickInFlight = false;
  }
}

// Run first tick immediately, then schedule next after current completes.
await guardedTick();
(function scheduleNext() {
  setTimeout(async () => {
    await guardedTick();
    scheduleNext();
  }, intervalMs);
})();
