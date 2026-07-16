import type { LooseRecord } from "../../shared/types.js";
export async function run(args: string[], { cpbRoot }: { cpbRoot: string; executorRoot?: string }) {
  const sub = args[0] || "";
  if (sub === "reconcile" || sub === "cleanup" || sub === "gc") {
    console.error("gc/reconcile has been removed. Use: jobs report");
  } else if (sub === "report") {
    const { buildJobRunReport, formatReportHuman } = await import("../../server/services/job/job-projection.js");
    const report = await (buildJobRunReport as (opts: LooseRecord) => Promise<unknown>)({ cpbRoot });
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else console.log(formatReportHuman(report));
  } else if (sub === "worktrees") {
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
    if (args.includes("--json")) console.log(JSON.stringify(plan, null, 2));
    else console.log(formatWorktreeRetentionHuman(plan));
  } else if (sub === "trace") {
    const project = args[1];
    const jobId = args[2];
    if (!project || !jobId) {
      console.error("Usage: cpb jobs trace <project> <jobId> [--json] [--replay] [--include-patch] [--data-root <path>]");
      return 1;
    }
    const dataRootIndex = args.indexOf("--data-root");
    const dataRoot = dataRootIndex >= 0 ? args[dataRootIndex + 1] : process.env.CPB_PROJECT_RUNTIME_ROOT || null;
    if (args.includes("--replay")) {
      const { buildJobReplay, formatJobReplayHuman } = await import("../../server/services/trace/trace-replay.js");
      const replay = await buildJobReplay({
        cpbRoot,
        project,
        jobId,
        dataRoot,
        includePatch: args.includes("--include-patch"),
      });
      if (args.includes("--json")) console.log(JSON.stringify(replay, null, 2));
      else console.log(formatJobReplayHuman(replay));
      return 0;
    }
    const { buildJobTrace, formatTraceHuman } = await import("../../server/services/trace/trace-log.js");
    const trace = await buildJobTrace({ cpbRoot, project, jobId, dataRoot });
    if (args.includes("--json")) console.log(JSON.stringify(trace, null, 2));
    else console.log(formatTraceHuman(trace));
  } else if (sub === "record-evaluation") {
    const project = args[1];
    const jobId = args[2];
    const fileIndex = args.indexOf("--file");
    const file = fileIndex >= 0 ? args[fileIndex + 1] : null;
    if (!project || !jobId || !file) {
      console.error("Usage: cpb jobs record-evaluation <project> <jobId> --file <evaluation.json> [--data-root <path>]");
      return 1;
    }
    const dataRootIndex = args.indexOf("--data-root");
    const dataRoot = dataRootIndex >= 0 ? args[dataRootIndex + 1] : process.env.CPB_PROJECT_RUNTIME_ROOT || null;
    const { readFile } = await import("node:fs/promises");
    const evaluation = JSON.parse(await readFile(file, "utf8"));
    const { recordExternalEvaluation } = await import("../../server/services/trace/trace-replay.js");
    const event = await recordExternalEvaluation({ cpbRoot, project, jobId, dataRoot, evaluation });
    console.log(JSON.stringify(event, null, 2));
    return 0;
  } else {
    const { resolveHubRoot } = await import("../../server/services/hub/hub-registry.js");
    const { listJobsAcrossRuntimeRoots } = await import("../../server/services/job/job-store.js");
    const jobs = await listJobsAcrossRuntimeRoots(cpbRoot, { hubRoot: process.env.CPB_HUB_ROOT || resolveHubRoot(cpbRoot) }) as Array<LooseRecord>;
    for (const job of jobs.slice(-20)) {
      console.log(`${job.jobId} ${job.status} ${job.project || "-"} ${job.phase || "-"}`);
    }
  }
}
