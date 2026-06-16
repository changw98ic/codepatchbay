export async function run(args, { cpbRoot }) {
    const sub = args[0] || "";
    if (sub === "reconcile" || sub === "cleanup" || sub === "gc") {
        console.error("gc/reconcile has been removed. Use: jobs report");
    }
    else if (sub === "report") {
        const { buildJobRunReport, formatReportHuman } = await import("../../server/services/job/job-projection.js");
        const report = await buildJobRunReport({ cpbRoot });
        if (args.includes("--json"))
            console.log(JSON.stringify(report, null, 2));
        else
            console.log(formatReportHuman(report));
    }
    else if (sub === "worktrees") {
        const { cleanupWorktrees, formatWorktreeRetentionHuman } = await import("../../server/services/cleanup/cleanup.js");
        const completedIndex = args.indexOf("--completed");
        const completed = completedIndex >= 0 ? args[completedIndex + 1] : "preserve";
        const archiveIndex = args.indexOf("--archive-root");
        const archiveRoot = archiveIndex >= 0 ? args[archiveIndex + 1] : undefined;
        const dryRun = args.includes("--dry-run") || !args.includes("--yes");
        const plan = await cleanupWorktrees(cpbRoot, {
            dryRun,
            policy: { completed, archiveRoot },
        });
        if (args.includes("--json"))
            console.log(JSON.stringify(plan, null, 2));
        else
            console.log(formatWorktreeRetentionHuman(plan));
    }
    else {
        const { resolveHubRoot } = await import("../../server/services/hub/hub-registry.js");
        const { listJobsAcrossRuntimeRoots } = await import("../../server/services/job/job-store.js");
        const jobs = await listJobsAcrossRuntimeRoots(cpbRoot, { hubRoot: process.env.CPB_HUB_ROOT || resolveHubRoot(cpbRoot) });
        for (const job of jobs.slice(-20)) {
            console.log(`${job.jobId} ${job.status} ${job.project || "-"} ${job.phase || "-"}`);
        }
    }
}
