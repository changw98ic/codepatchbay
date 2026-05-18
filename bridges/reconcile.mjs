#!/usr/bin/env node
import path from "node:path";
import { reconcileJobs } from "../server/services/reconcile.js";

const cpbRoot = path.resolve(process.env.CPB_ROOT || path.join(import.meta.dirname, ".."));

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const report = await reconcileJobs(cpbRoot, { dryRun });

if (dryRun) {
  console.log("=== Reconcile Dry-Run Report ===");
} else {
  console.log("=== Reconcile Report ===");
}

if (report.staleJobs.length > 0) {
  console.log(`\nStale jobs (${report.staleJobs.length}):`);
  for (const j of report.staleJobs) {
    const action = dryRun ? "[would fail]" : "[failed]";
    console.log(`  ${action} ${j.jobId} (${j.project}): ${j.reason}`);
    if (j.worktree) {
      console.log(`    worktree preserved: ${j.worktree}`);
    }
  }
} else {
  console.log("\nNo stale jobs found.");
}

if (report.orphanLeases.length > 0) {
  console.log(`\nOrphan leases (${report.orphanLeases.length}):`);
  for (const l of report.orphanLeases) {
    const action = dryRun ? "[would remove]" : "[removed]";
    console.log(`  ${action} ${l.leaseId}: ${l.reason}`);
  }
} else {
  console.log("\nNo orphan leases found.");
}

if (report.workers.stale.length > 0) {
  console.log(`\nStale workers (${report.workers.stale.length}):`);
  for (const w of report.workers.stale) {
    const action = dryRun ? "[would clear]" : "[cleared]";
    console.log(`  ${action} ${w.project} worker ${w.workerId} (pid ${w.pid})`);
  }
} else {
  console.log("\nNo stale workers found.");
}

if (report.streamRepairs.length > 0) {
  console.log(`\nRepaired event streams (${report.streamRepairs.length}):`);
  for (const s of report.streamRepairs) {
    console.log(`  ${s.project}/${s.jobId}`);
  }
}

if (report.streamErrors.length > 0) {
  console.log(`\nUnrepairable event stream errors (${report.streamErrors.length}):`);
  for (const e of report.streamErrors) {
    console.log(`  FAIL ${e.project}/${e.jobId}: ${e.reason} at line ${e.lineNumber}`);
  }
}

if (report.indexRebuilt) {
  console.log("\nJobs index rebuilt.");
}

if (report.streamErrors.length > 0) {
  process.exitCode = 1;
}
