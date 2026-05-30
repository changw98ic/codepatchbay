#!/usr/bin/env node
import path from "node:path";

export async function run(args, { cpbRoot }) {
  const dryRun = args.includes("--dry-run");
  const repoFlag = args.indexOf("--repo");
  const repo = repoFlag >= 0 && args[repoFlag + 1] ? args[repoFlag + 1] : null;

  const { runBacklogHygiene } = await import("../../server/services/backlog-hygiene.js");
  const report = await runBacklogHygiene(cpbRoot, { dryRun, repo });

  if (dryRun) {
    console.log("=== Backlog Hygiene Dry-Run Report ===");
  } else {
    console.log("=== Backlog Hygiene Report ===");
  }

  console.log(`\nIssues scanned: ${report.issuesScanned}`);

  if (report.staleComments.length > 0) {
    console.log(`\nStale CPB comments (${report.staleComments.length}):`);
    for (const c of report.staleComments) {
      const action = dryRun ? "[would mark]" : "[marked]";
      console.log(`  ${action} ${c.repo}#${c.issueNumber} comment ${c.commentId} (${c.commentKind}, job ${c.jobId || "?"})`);
      if (c.supersededByJobId) {
        console.log(`    superseded by job: ${c.supersededByJobId}`);
      }
    }
  } else {
    console.log("\nNo stale CPB comments found.");
  }

  if (report.supersededIssues.length > 0) {
    console.log(`\nSuperseded issues closed (${report.supersededIssues.length}):`);
    for (const i of report.supersededIssues) {
      const action = dryRun ? "[would close]" : "[closed]";
      console.log(`  ${action} ${i.repo}#${i.issueNumber} (${i.reason})`);
      if (i.supersededByQueueEntryId) {
        console.log(`    replaced by: ${i.supersededByQueueEntryId}`);
      }
    }
  } else {
    console.log("\nNo superseded issues to close.");
  }

  if (report.errors.length > 0) {
    console.log(`\nErrors (${report.errors.length}):`);
    for (const e of report.errors) {
      console.log(`  ${e.repo}#${e.issueNumber} ${e.phase}: ${e.message}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cpbRoot = path.resolve(process.env.CPB_ROOT || path.join(import.meta.dirname, ".."));
  run(process.argv.slice(2), { cpbRoot });
}
