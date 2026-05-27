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

const autoSyncState = new Map();

async function tickAutoEnqueue() {
  try {
    const { listProjects } = await import("../server/services/hub-registry.js");
    const { resolveHubRoot } = await import("../server/services/hub-registry.js");
    const hubRoot = resolveHubRoot(cpbRoot);
    const projects = await listProjects(hubRoot);

    for (const project of projects) {
      const automation = project.github?.automation;
      if (!automation?.enabled || !automation.syncIntervalSec) continue;

      const lastSync = autoSyncState.get(project.id) || 0;
      const elapsed = (Date.now() - lastSync) / 1000;
      if (elapsed < automation.syncIntervalSec) continue;

      const repo = project.github?.fullName;
      if (!repo) continue;

      try {
        // Set per-project runtime root so event/lease/job writes go to the right place
        const prevRuntimeRoot = process.env.CPB_PROJECT_RUNTIME_ROOT;
        if (project.projectRuntimeRoot) {
          process.env.CPB_PROJECT_RUNTIME_ROOT = project.projectRuntimeRoot;
        }

        const { syncGithubIssuesFromGh } = await import("../server/services/github-issues.js");
        await syncGithubIssuesFromGh(hubRoot, { repo, projectId: project.id, state: "open", limit: 500, cwd: cpbRoot });

        const { autoEnqueueSyncedIssues } = await import("../server/services/auto-enqueue.js");
        const result = await autoEnqueueSyncedIssues(hubRoot, cpbRoot, project.id);
        autoSyncState.set(project.id, Date.now());

        if (result.enqueued > 0) {
          log("auto-enqueue", `${project.id}: ${result.enqueued} issues enqueued, ${result.skipped} skipped, ${result.duplicates} dupes`);
        }

        // Restore previous env
        if (prevRuntimeRoot === undefined) {
          delete process.env.CPB_PROJECT_RUNTIME_ROOT;
        } else {
          process.env.CPB_PROJECT_RUNTIME_ROOT = prevRuntimeRoot;
        }
      } catch (err) {
        log("auto-enqueue-error", `${project.id}: ${err.message}`);
      }
    }
  } catch (err) {
    log("auto-enqueue-error", `scan failed: ${err.message}`);
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
await tickAutoEnqueue();
(function scheduleNext() {
  setTimeout(async () => {
    await guardedTick();
    scheduleNext();
  }, intervalMs);
})();

// Auto-enqueue runs on its own longer interval (default 5 min).
const autoEnqueueMs = Number(process.env.CPB_AUTO_ENQUEUE_INTERVAL_MS || 300_000);
(async function autoEnqueueLoop() {
  while (true) {
    await new Promise((r) => setTimeout(r, autoEnqueueMs));
    await tickAutoEnqueue();
  }
})();
