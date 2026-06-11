export async function run(args: string[], { cpbRoot }: { cpbRoot: string; executorRoot?: string }) {
  const sub = args[0] || "";
  if (sub === "reconcile") {
    const mod = await import("./reconcile.js");
    await mod.run(args.slice(1), { cpbRoot });
  } else if (sub === "cleanup" || sub === "gc") {
    const mod = await import("./reconcile.js");
    await mod.run(args.slice(1), { cpbRoot });
  } else if (sub === "report") {
    const { buildJobRunReport, formatReportHuman } = await import("../../server/services/job-run-report.js");
    const report = await (buildJobRunReport as any)({ cpbRoot });
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else console.log(formatReportHuman(report));
  } else if (sub === "worktrees") {
    const { cleanupWorktrees, formatWorktreeRetentionHuman } = await import("../../server/services/worktree-retention.js");
    const completedIndex = args.indexOf("--completed");
    const completed = completedIndex >= 0 ? args[completedIndex + 1] : "preserve";
    const archiveIndex = args.indexOf("--archive-root");
    const archiveRoot = archiveIndex >= 0 ? args[archiveIndex + 1] : undefined;
    const dryRun = args.includes("--dry-run") || !args.includes("--yes");
    const plan = await cleanupWorktrees(cpbRoot, {
      dryRun,
      policy: { completed, archiveRoot },
    });
    if (args.includes("--json")) console.log(JSON.stringify(plan, null, 2));
    else console.log(formatWorktreeRetentionHuman(plan));
  } else {
    const { resolveHubRoot } = await import("../../server/services/hub-registry.js");
    const { listJobsAcrossRuntimeRoots } = await import("../../server/services/job-store.js");
    const jobs = await listJobsAcrossRuntimeRoots(cpbRoot, { hubRoot: process.env.CPB_HUB_ROOT || resolveHubRoot(cpbRoot) }) as Array<Record<string, any>>;
    for (const job of jobs.slice(-20)) {
      console.log(`${job.jobId} ${job.status} ${job.project || "-"} ${job.phase || "-"}`);
    }
  }
}
