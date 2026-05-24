#!/usr/bin/env node
import path from "node:path";

export async function run(args, { cpbRoot }) {
  const dryRun = args.includes("--dry-run");
  const { reconcileJobs } = await import("../../server/services/reconcile.js");
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

  if (report.pollution) {
    const p = report.pollution;
    console.log(`\nPollution cleanup: ${p.projectsRemoved} project(s) removed, ${p.orphanDirsRemoved} orphan dir(s) removed`);
    if (p.unsafeProjectsSkipped?.length > 0) {
      console.log(`  Skipped ${p.unsafeProjectsSkipped.length} unsafe target(s)`);
    }
  }

  if (report.pollutionPreview) {
    const pp = report.pollutionPreview;
    console.log(`\nPollution preview (${dryRun ? "dry-run" : "preview"}): ${pp.testProjectsToRemove} test project(s), ${pp.orphanRuntimeDirsToRemove} orphan dir(s)`);
    if (pp.candidates?.length > 0) {
      for (const c of pp.candidates) {
        console.log(`  [would remove] ${c.projectId}: ${c.reasons?.join(", ")}`);
      }
    }
    if (pp.orphanDirs?.length > 0) {
      for (const d of pp.orphanDirs) {
        console.log(`  [would remove] orphan: ${d.projectId}`);
      }
    }
  }

  if (report.streamErrors.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cpbRoot = path.resolve(process.env.CPB_ROOT || path.join(import.meta.dirname, ".."));
  run(process.argv.slice(2), { cpbRoot });
}
