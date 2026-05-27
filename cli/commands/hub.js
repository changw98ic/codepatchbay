import path from "node:path";

export async function run(args, { cpbRoot, executorRoot }) {
  const sub = args[0] || "status";
  const json = args.includes("--json");
  const { hubStatus, listProjects, resolveHubRoot, workerStatus } = await import("../../server/services/hub-registry.js").then(m => ({
    hubStatus: m.hubStatus, listProjects: m.listProjects, resolveHubRoot: m.resolveHubRoot, workerStatus: m.workerStatus,
  }));
  const { readHubLiveness } = await import("../../server/services/hub-runtime.js");
  const hubRoot = resolveHubRoot(cpbRoot);

  if (sub === "status") {
    const status = await hubStatus(hubRoot);
    const liveness = await readHubLiveness(hubRoot);
    if (json) {
      console.log(JSON.stringify({ ...status, liveness }, null, 2));
    } else {
      const liveTag = liveness.alive ? "alive" : `down (${liveness.reason})`;
      console.log(`Hub: ${status.hubRoot}`);
      console.log(`Server: ${liveTag}`);
      console.log(`Projects: ${status.enabledProjectCount}/${status.projectCount} enabled`);
      console.log(`Workers: ${status.workersOnline} online, ${status.workersStale} stale, ${status.workersOffline} offline`);
    }
  } else if (sub === "projects") {
    const projects = await listProjects(hubRoot);
    if (json) {
      console.log(JSON.stringify(projects, null, 2));
    } else {
      if (projects.length === 0) console.log("No Hub projects. Run: cpb attach [path] [name]");
      for (const project of projects) {
        const worker = project.worker?.lastSeenAt ? ` worker:${workerStatus(project)}` : "";
        console.log(`${project.enabled === false ? "-" : "+"} ${project.id}\t${project.sourcePath}${worker}`);
      }
    }
  } else if (sub === "start") {
    const { cmdStart } = await import("../../server/services/hub-cli.js");
    await cmdStart();
  } else if (sub === "stop") {
    const { cmdStop } = await import("../../server/services/hub-cli.js");
    await cmdStop();
  } else if (sub === "acp") {
    const { getManagedAcpPool } = await import("../../server/services/acp-pool.js");
    const pool = getManagedAcpPool({ cpbRoot, hubRoot });
    const status = { ...pool.status(), rateLimits: await pool.readDurableRateLimits() };
    if (json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log("ACP pools:");
      for (const [agent, info] of Object.entries(status.pools || {})) {
        const limit = status.rateLimits?.[agent];
        const backoff = limit?.untilTs ? ` backoff:${limit.untilTs}` : "";
        console.log(`  ${agent}\tmode:${info.mode} limit:${info.limit} active:${info.active} queued:${info.queued}${backoff}`);
      }
    }
  } else if (sub === "queue" || sub === "queue-status") {
    const { listQueue, queueStatus } = await import("../../server/services/hub-queue.js");
    if (sub === "queue-status") {
      const qs = await queueStatus(hubRoot);
      if (json) console.log(JSON.stringify(qs, null, 2));
      else {
        console.log(`Queue: ${qs.total} entries`);
        console.log(`  pending:${qs.pending} in_progress:${qs.inProgress} completed:${qs.completed} failed:${qs.failed} cancelled:${qs.cancelled}`);
        if (qs.eligibleQueued > 0) {
          console.log(`  eligible:${qs.eligibleQueued} projects:${qs.eligibleProjects?.join(",") || ""}`);
        }
        if (qs.projects && Object.keys(qs.projects).length > 0) {
          for (const [pid, ps] of Object.entries(qs.projects)) {
            let line = `  ${pid}\tpending:${ps.pending} active:${ps.inProgress}`;
            if (ps.eligiblePending > 0) line += ` eligible:${ps.eligiblePending}`;
            if (ps.failed > 0) line += ` failed:${ps.failed}`;
            if (ps.busy) {
              line += ` BUSY`;
              if (ps.busyReason) line += `(${ps.busyReason})`;
              if (ps.workerId) line += ` worker:${ps.workerId}`;
            }
            console.log(line);
          }
        }
      }
    } else {
      const entries = await listQueue(hubRoot);
      if (json) console.log(JSON.stringify(entries, null, 2));
      else {
        if (entries.length === 0) console.log("Queue is empty");
        for (const e of entries) console.log(`${e.status}\t${e.priority}\t${e.projectId}\t${e.description || e.id}`);
      }
    }
  } else if (sub === "github-sync") {
    const { syncGithubIssuesFromGh } = await import("../../server/services/github-issues.js");
    const result = await syncGithubIssuesFromGh(hubRoot, { repo: null, projectId: "flow", state: "open", limit: 1000, cwd: cpbRoot });
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(`GitHub issues synced: ${result.count}`);
  } else if (sub === "enqueue-issues") {
    const eqProject = args[1] && !args[1].startsWith("--") ? args[1] : null;
    if (!eqProject) {
      console.error("Usage: cpb hub enqueue-issues <project> [--dry-run] [--sync-first] [--json]");
      process.exit(1);
    }
    const dryRun = args.includes("--dry-run");
    const syncFirst = args.includes("--sync-first");

    if (syncFirst) {
      const { syncGithubIssuesFromGh } = await import("../../server/services/github-issues.js");
      const proj = await (await import("../../server/services/hub-registry.js")).getProject(hubRoot, eqProject);
      const repo = proj?.github?.fullName;
      if (repo) {
        const syncResult = await syncGithubIssuesFromGh(hubRoot, { repo, projectId: eqProject, state: "open", limit: 500, cwd: cpbRoot });
        if (!json) console.log(`Synced ${syncResult.count} issues from ${repo}`);
      } else {
        console.error(`Project '${eqProject}' has no GitHub binding. Run: cpb github bind ${eqProject} <owner/repo>`);
        process.exit(1);
      }
    }

    const { autoEnqueueSyncedIssues } = await import("../../server/services/auto-enqueue.js");
    const result = await autoEnqueueSyncedIssues(hubRoot, cpbRoot, eqProject, { dryRun });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const prefix = dryRun ? "[DRY RUN] " : "";
      console.log(`${prefix}Auto-enqueue for '${eqProject}': ${result.enqueued} enqueued, ${result.skipped} skipped, ${result.duplicates} already queued (of ${result.total} open issues)`);
      if (dryRun && result.matched?.length) {
        console.log("\nMatched issues:");
        for (const m of result.matched) {
          console.log(`  #${m.number} ${m.title} → ${m.rule} (${m.action?.workflow || "standard"}, ${m.action?.priority || "P2"})`);
        }
      }
    }
  } else if (sub === "diagnostics") {
    const { gatherDiagnostics } = await import("../../server/services/diagnostics-bundle.js");
    const diag = await gatherDiagnostics({ cpbRoot, hubRoot });
    if (json) console.log(JSON.stringify(diag, null, 2));
    else {
      console.log(`Diagnostics gathered at: ${diag.gatheredAt}`);
      console.log(`Hub: ${diag.hub.hubRoot}`);
      console.log(`Projects: ${diag.hub.enabledProjectCount}/${diag.hub.projectCount} enabled`);
      console.log(`Queue: ${diag.queue.total} (${diag.queue.pending} pending, ${diag.queue.inProgress} active)`);
    }
  } else if (sub === "observe") {
    const { buildChainSnapshot, analyzeChainSnapshot } = await import("../../server/services/observer.js");
    const observeProject = args[1] && !args[1].startsWith("--") ? args[1] : null;
    const observeJobId = args[2] && !args[2].startsWith("--") ? args[2] : null;

    if (!observeProject || !observeJobId) {
      console.error("Usage: cpb hub observe <project> <job-id> [--json]");
      process.exit(1);
    }

    const snapshot = await buildChainSnapshot({ cpbRoot, hubRoot, project: observeProject, jobId: observeJobId });
    const analysis = analyzeChainSnapshot(snapshot);

    if (json) {
      console.log(JSON.stringify({ snapshot, analysis }, null, 2));
    } else {
      console.log(`Recommendation: ${analysis.recommendation}`);
      console.log(`Reasons:`);
      for (const r of analysis.reasons) console.log(`  - ${r}`);
      if (snapshot.job) {
        console.log(`Job: ${snapshot.job.jobId} status=${snapshot.job.status} phase=${snapshot.job.phase || "-"}`);
      }
      if (snapshot.lease) {
        console.log(`Lease: ${snapshot.lease.leaseId} expires=${snapshot.lease.expiresAt}`);
      }
      console.log(`Events: ${snapshot.eventTail.length} (tail)`);
      console.log(`Inbox pending: ${snapshot.inboxPending}`);
      console.log(`Snapshot at: ${snapshot.timestamp}`);
    }
  } else {
    console.error(`Unknown hub subcommand: ${sub}`);
    process.exit(1);
  }
}
