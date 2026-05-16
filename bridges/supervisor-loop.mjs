#!/usr/bin/env node
import path from "node:path";
import { recoverAndRun } from "../server/services/supervisor.js";

const cpbRoot = path.resolve(
  process.env.CPB_ROOT || path.join(import.meta.dirname, "..")
);
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
    results = await recoverAndRun(cpbRoot, { maxConcurrent });
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

// Run first tick immediately, then poll on interval.
await tick();
setInterval(() => {
  tick().catch((err) => {
    log("error", `tick crashed: ${err.message}`);
  });
}, intervalMs);
