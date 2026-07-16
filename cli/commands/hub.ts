import type { LooseRecord } from "../../shared/types.js";

function recordValue(value: unknown): LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function recordArray(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? value.map(recordValue) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function optionValue(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

export async function run(args: string[], { cpbRoot, executorRoot }: LooseRecord) {
  const sub = args[0] || "status";
  const json = args.includes("--json");
  const { getProject, hubStatus, listProjects, resolveHubRoot } = await import("../../server/services/hub/hub-registry.js").then(m => ({
    getProject: m.getProject, hubStatus: m.hubStatus, listProjects: m.listProjects, resolveHubRoot: m.resolveHubRoot,
  }));
  const { readHubLiveness } = await import("../../server/services/hub/hub-registry.js");
  const hubRoot = resolveHubRoot(cpbRoot);

  if (sub === "status") {
    const { readLeaderStatus } = await import("../../server/orchestrator/leader-lock.js");
    const { WorkerStore, summarizeWorkers } = await import("../../shared/orchestrator/worker-store.js");
    const { queueStatus } = await import("../../server/services/hub/hub-queue.js");
    const { getManagedAcpPool } = await import("../../server/services/acp/acp-pool.js");
    const { hubConcurrencyEnv, resolveHubConcurrencyLimits } = await import("../../server/services/infra.js");
    const workerStore = new WorkerStore(hubRoot);
    const poolEnv = { ...process.env, ...hubConcurrencyEnv(await resolveHubConcurrencyLimits(hubRoot)) };
    const pool = getManagedAcpPool({ cpbRoot, hubRoot, env: poolEnv });
    const [status, liveness, orchestrator, queue, workers, poolLeases] = await Promise.all([
      hubStatus(hubRoot),
      readHubLiveness(hubRoot),
      readLeaderStatus(hubRoot),
      queueStatus(hubRoot),
      workerStore.listWorkers(),
      pool.connectionLeaseStatus().catch(() => ({ total: 0, providers: {} })),
    ]);
    const leaseStatus = poolLeases as LooseRecord;
    const managedWorkers = summarizeWorkers(workers);
    if (json) {
      console.log(JSON.stringify({
        hubRoot: status.hubRoot,
        registryPath: status.registryPath,
        projectCount: status.projectCount,
        enabledProjectCount: status.enabledProjectCount,
        updatedAt: status.updatedAt,
        liveness,
        orchestrator,
        queue,
        workers: managedWorkers,
        poolLeases: leaseStatus,
      }, null, 2));
    } else {
      const liveTag = liveness.alive ? "alive" : `down (${liveness.reason})`;
      const orchestratorTag = orchestrator.status === "running"
        ? `running pid:${orchestrator.pid || "-"} epoch:${orchestrator.epoch || 0}`
        : `stopped${orchestrator.hubId ? ` hubId:${orchestrator.hubId}` : ""}`;
      console.log(`Hub: ${status.hubRoot}`);
      console.log(`Server: ${liveTag}`);
      console.log(`Orchestrator: ${orchestratorTag}`);
      console.log(`Projects: ${status.enabledProjectCount}/${status.projectCount} enabled`);
      console.log(`Queue: ${queue.total} entries pending:${queue.pending} scheduled:${queue.scheduled || 0} running:${queue.inProgress} completed:${queue.completed} blocked:${queue.blocked || 0} ${formatFailedSummary(queue)}`);
      console.log(`Workers: ${formatManagedWorkerSummary(managedWorkers)}`);
      const defaultLimit = pool.providerConnectionLimit;
      const knownKeys = await pool.getKnownProviderKeys();
      const allProviders = new Set([
        ...Object.keys(leaseStatus.providers),
        ...knownKeys,
      ]);
      const poolParts = [...allProviders].sort().map((k) => {
        const active = leaseStatus.providers[k] || 0;
        const limit = pool.getProviderLimit(k);
        return `${k}:${active}/${limit}`;
      });
      const noLease = poolParts.length === 0 ? ` 0/${defaultLimit}` : "";
      console.log(`ACP Pool: ${poolParts.join(" ")}${noLease}`);
    }
  } else if (sub === "projects") {
    const projects = await listProjects(hubRoot);
    if (json) {
      console.log(JSON.stringify(projects, null, 2));
    } else {
      if (projects.length === 0) console.log("No Hub projects. Run: cpb init <path> [name]");
      for (const project of projects) {
        console.log(`${project.enabled === false ? "-" : "+"} ${project.id}\t${project.sourcePath}`);
      }
    }
  } else if (sub === "start") {
    const { cmdStart } = await import("../../server/services/hub/hub-registry.js");
    await cmdStart();
  } else if (sub === "stop") {
    const { cmdStop } = await import("../../server/services/hub/hub-registry.js");
    await cmdStop();
  } else if (sub === "acp") {
    const { getManagedAcpPool } = await import("../../server/services/acp/acp-pool.js");
    const { hubConcurrencyEnv, resolveHubConcurrencyLimits } = await import("../../server/services/infra.js");
    const poolEnv = { ...process.env, ...hubConcurrencyEnv(await resolveHubConcurrencyLimits(hubRoot)) };
    const pool = getManagedAcpPool({ cpbRoot, hubRoot, env: poolEnv });
    const status: LooseRecord = { ...pool.status(), providerQuotas: await pool.readProviderQuotas() };
    if (json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log("ACP pools:");
      const pools = recordValue(status.pools);
      const providerQuotas = recordValue(status.providerQuotas);
      for (const [agent, rawInfo] of Object.entries(pools)) {
        const info = recordValue(rawInfo);
        const limit = recordValue(providerQuotas[agent]);
        const backoff = limit?.untilTs ? ` backoff:${limit.untilTs}` : "";
        console.log(`  ${agent}\tmode:${info.mode} limit:${info.limit} active:${info.active} queued:${info.queued}${backoff}`);
      }
    }
  } else if (sub === "queue" || sub === "queue-status") {
    const { listQueue, queueStatus } = await import("../../server/services/hub/hub-queue.js");
    if (sub === "queue-status") {
      const qs = await queueStatus(hubRoot);
      if (json) console.log(JSON.stringify(qs, null, 2));
      else {
        console.log(`Queue: ${qs.total} entries`);
        console.log(`  pending:${qs.pending} scheduled:${qs.scheduled || 0} in_progress:${qs.inProgress} completed:${qs.completed} blocked:${qs.blocked || 0} ${formatFailedSummary(qs)} cancelled:${qs.cancelled}`);
        console.log(`  active-mutating:${qs.activeMutatingTotal || 0}`);
        if (qs.eligibleQueued > 0) {
          console.log(`  eligible:${qs.eligibleQueued} projects:${stringArray(qs.eligibleProjects).join(",") || ""}`);
        }
        if (qs.projects && Object.keys(qs.projects).length > 0) {
          for (const [pid, rawProjectStatus] of Object.entries(recordValue(qs.projects))) {
            const ps = recordValue(rawProjectStatus);
            let line = `  ${pid}\tpending:${ps.pending} scheduled:${ps.scheduled || 0} active:${ps.inProgress}`;
            if (ps.maxActivePerProject) line += ` cap:${ps.activeMutating}/${ps.maxActivePerProject}`;
            if (numberValue(ps.eligiblePending) > 0) line += ` eligible:${ps.eligiblePending}`;
            if (numberValue(ps.blocked) > 0) line += ` blocked:${ps.blocked}`;
            if (numberValue(ps.failedEntries || ps.failed) > 0) line += ` ${formatFailedSummary(ps)}`;
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
    const syncProject = args[1] && !args[1].startsWith("--") ? args[1] : null;
    const shouldAutoEnqueue = !args.includes("--no-enqueue");
    const { syncConfiguredGithubIssuesFromGh } = await import("../../server/services/github/github-issues.js");
    const result: LooseRecord = await syncConfiguredGithubIssuesFromGh(hubRoot, { projectId: syncProject, state: "open", limit: 1000, cwd: cpbRoot });
    const resultProjects = recordArray(result.projects);
    if (shouldAutoEnqueue && resultProjects.length) {
      const { autoEnqueueSyncedIssues } = await import("../../server/services/hub/hub-queue.js");
      result.autoEnqueue = [];
      const autoEnqueue = recordArray(result.autoEnqueue);
      for (const project of resultProjects) {
        autoEnqueue.push({
          projectId: project.projectId,
          ...await autoEnqueueSyncedIssues(hubRoot, cpbRoot, String(project.projectId)),
        });
      }
      result.autoEnqueue = autoEnqueue;
    }
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      if (result.projectCount === 0) {
        console.log("No GitHub-bound Hub projects to sync. Run: cpb github bind <project> <owner/repo>");
      } else {
        console.log(`GitHub issues synced: ${result.count} across ${result.projectCount} project(s)`);
        for (const project of resultProjects) {
          console.log(`  ${project.projectId}\t${project.repo}\t${project.count}`);
        }
      }
      for (const skipped of recordArray(result.skipped)) {
        console.log(`  skipped ${skipped.projectId}: ${skipped.reason}`);
      }
      for (const eq of recordArray(result.autoEnqueue)) {
        if (eq.error) console.log(`  auto-enqueue ${eq.projectId}: ${eq.error}`);
        else {
          console.log(`  auto-enqueue ${eq.projectId}: ${eq.enqueued} enqueued, ${eq.skipped} skipped, ${eq.duplicates} already queued`);
        }
      }
    }
  } else if (sub === "enqueue-issues") {
    const eqProject = args[1] && !args[1].startsWith("--") ? args[1] : null;
    if (eqProject && !process.env.CPB_PROJECT_RUNTIME_ROOT) {
      try {
        const proj = await getProject(hubRoot, eqProject);
        if (proj?.projectRuntimeRoot) process.env.CPB_PROJECT_RUNTIME_ROOT = proj.projectRuntimeRoot;
      } catch {}
    }
    if (!eqProject) {
      console.error("Usage: cpb hub enqueue-issues <project> [--dry-run] [--sync-first] [--json]");
      process.exit(1);
    }
    const dryRun = args.includes("--dry-run");
    const syncFirst = args.includes("--sync-first");

    if (syncFirst) {
      const { syncGithubIssuesFromGh } = await import("../../server/services/github/github-issues.js");
      const proj = await (await import("../../server/services/hub/hub-registry.js")).getProject(hubRoot, eqProject);
      const repo = proj?.github?.fullName;
      if (repo) {
        const syncResult = await syncGithubIssuesFromGh(hubRoot, { repo, projectId: eqProject, state: "open", limit: 500, cwd: proj.sourcePath || cpbRoot });
        if (!json) console.log(`Synced ${syncResult.count} issues from ${repo}`);
      } else {
        console.error(`Project '${eqProject}' has no GitHub binding. Run: cpb github bind ${eqProject} <owner/repo>`);
        process.exit(1);
      }
    }

    const { autoEnqueueSyncedIssues } = await import("../../server/services/hub/hub-queue.js");
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
  } else if (sub === "migrate-to-redis") {
    const output = optionValue(args, "--output");
    const configFile = process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE;
    if (!output || !configFile) {
      console.error("Usage: CPB_HUB_STATE_REDIS_CONFIG_FILE=... cpb hub migrate-to-redis --output PATH [--yes] [--json]");
      return 1;
    }
    const { migrateLocalHubToRedis } = await import("../../server/services/hub/hub-redis-migration.js");
    const result = await migrateLocalHubToRedis({
      cpbRoot,
      hubRoot,
      configFile,
      output,
      dryRun: !args.includes("--yes"),
      backupSigningKey: process.env.CPB_HUB_BACKUP_SIGNING_KEY,
      auditSigningKey: process.env.CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY,
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (result.dryRun === true) {
      console.log("Hub Local-to-Redis Migration (dry-run)");
      console.log(`Projects: ${result.projects}, queue entries: ${result.queueEntries}`);
      console.log(`Assignments/attempts: ${result.assignments}/${result.attempts}`);
      console.log(`Workers/inbox: ${result.workers}/${result.inboxEntries}`);
      console.log(`Leases: ${result.leases}, jobs/events: ${result.jobs}/${result.jobEvents}`);
      console.log("No state changed. Stop/drain the Hub and re-run with --yes.");
    } else {
      console.log(`Hub local-to-Redis migration completed: ${result.output}`);
      console.log(`Rollback backup: ${result.backupPath}`);
      console.log(`Snapshot: ${result.snapshotSha256}`);
    }
    return 0;
  } else if (sub === "recover-redis-migration") {
    const { recoverHubRedisMigration } = await import("../../server/services/hub/hub-redis-migration.js");
    const result = await recoverHubRedisMigration({
      hubRoot,
      configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
      backupSigningKey: process.env.CPB_HUB_BACKUP_SIGNING_KEY,
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (result.recovered) console.log(`Hub Redis migration recovery completed: ${result.migrationId}`);
    else console.log("No interrupted Hub Redis migration was found.");
    return 0;
  } else if (sub === "backup") {
    const output = optionValue(args, "--output");
    if (!output) {
      console.error("Usage: cpb hub backup --output PATH [--allow-unsigned-dev] [--json]");
      return 1;
    }
    const { createHubBackup } = await import("../../server/services/hub/hub-backup.js");
    const result = await createHubBackup({
      cpbRoot,
      hubRoot,
      output,
      signingKey: process.env.CPB_HUB_BACKUP_SIGNING_KEY,
      allowUnsignedDev: args.includes("--allow-unsigned-dev"),
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Hub backup created: ${result.output}`);
      console.log(`Snapshot: ${result.manifest.snapshotId}`);
      console.log(`Roots: ${result.manifest.roots.length}, files: ${result.manifest.fileCount}, bytes: ${result.manifest.totalBytes}`);
    }
    return 0;
  } else if (sub === "redis-retention") {
    const before = optionValue(args, "--before");
    const tombstonesBefore = optionValue(args, "--tombstones-before");
    const limitRaw = optionValue(args, "--limit");
    if (before === "" || tombstonesBefore === "" || limitRaw === "") {
      console.error("Usage: cpb hub redis-retention [--before ISO] [--tombstones-before ISO] [--limit N] [--yes] [--json]");
      return 1;
    }
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    const { runHubRedisRetention } = await import("../../server/services/hub/hub-redis-retention.js");
    const result = await runHubRedisRetention({
      hubRoot,
      before: before ?? undefined,
      tombstonesBefore: tombstonesBefore ?? undefined,
      limit,
      dryRun: !args.includes("--yes"),
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.dryRun ? "Hub Redis Retention (dry-run)" : "Hub Redis Retention");
      console.log(`Terminal jobs eligible: ${result.terminalJobs.length} (before ${result.before})`);
      console.log(`Tombstones eligible: ${result.tombstones.length} (before ${result.tombstonesBefore})`);
      console.log(`Legacy tombstones to timestamp: ${result.unstampedTombstones.length}`);
      if (!result.dryRun) {
        console.log(`Purged jobs: ${result.result.jobsPurged}`);
        console.log(`Deleted tombstones: ${result.result.tombstonesDeleted}`);
        console.log(`Timestamped tombstones: ${result.result.tombstonesStamped}`);
        console.log(`Conflicts/skips: ${result.result.conflicts}`);
      } else {
        console.log("No state changed. Re-run with --yes after taking a verified backup.");
      }
    }
    return 0;
  } else if (sub === "verify-backup") {
    const input = optionValue(args, "--input");
    if (!input) {
      console.error("Usage: cpb hub verify-backup --input PATH [--allow-unsigned-dev] [--json]");
      return 1;
    }
    const { verifyHubBackup } = await import("../../server/services/hub/hub-backup.js");
    const result = await verifyHubBackup(input, {
      signingKey: process.env.CPB_HUB_BACKUP_SIGNING_KEY,
      requireSignature: !args.includes("--allow-unsigned-dev"),
      allowUnsignedDev: args.includes("--allow-unsigned-dev"),
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Hub backup verified: ${result.backupRoot}`);
      console.log(`Snapshot: ${result.manifest.snapshotId}`);
      console.log(`Roots: ${result.manifest.roots.length}, files: ${result.manifest.fileCount}, bytes: ${result.manifest.totalBytes}`);
    }
    return 0;
  } else if (sub === "verify-access-audit") {
    const [{ verifyHubAccessAudit, verifyRedisHubAccessAudit }, { openHubRedisStateBackend }] = await Promise.all([
      import("../../server/services/audit/hub-access-audit.js"),
      import("../../shared/hub-state-redis.js"),
    ]);
    const redis = await openHubRedisStateBackend({
      hubRoot, configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    });
    const verified = redis
      ? await verifyRedisHubAccessAudit(redis)
      : await verifyHubAccessAudit({ hubRoot });
    const result = {
      filePath: verified.filePath,
      recordCount: verified.recordCount,
      lastSequence: verified.lastSequence,
      lastHash: verified.lastHash,
      sizeBytes: verified.sizeBytes,
      maxBytes: verified.maxBytes,
    };
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Hub access audit verified: ${result.filePath}`);
      console.log(`Records: ${result.recordCount}, bytes: ${result.sizeBytes}/${result.maxBytes}`);
      console.log(`Last sequence: ${result.lastSequence}, hash: ${result.lastHash}`);
    }
    return 0;
  } else if (sub === "archive-access-audit") {
    const output = optionValue(args, "--output");
    if (!output) {
      console.error("Usage: cpb hub archive-access-audit --output PATH [--json]");
      return 1;
    }
    const { openHubRedisStateBackend } = await import("../../shared/hub-state-redis.js");
    const redis = await openHubRedisStateBackend({
      hubRoot, configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    });
    if (redis) {
      console.error("Redis access audit is a shared Stream; use: cpb hub export-access-audit --output PATH");
      return 1;
    }
    const { createHubAccessAuditArchive } = await import("../../server/services/audit/hub-access-audit-archive.js");
    const result = await createHubAccessAuditArchive({
      hubRoot,
      output,
      signingKey: process.env.CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY,
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Hub access-audit archive created: ${result.output}`);
      console.log(`Archive: ${result.manifest.archiveId}`);
      console.log(`Records: ${result.manifest.recordCount}, bytes: ${result.manifest.sizeBytes}`);
      console.log(`Last sequence: ${result.manifest.lastSequence}, hash: ${result.manifest.lastHash}`);
    }
    return 0;
  } else if (sub === "export-access-audit") {
    const output = optionValue(args, "--output");
    if (!output) {
      console.error("Usage: cpb hub export-access-audit --output PATH [--json]");
      return 1;
    }
    const [{ openHubRedisStateBackend }, { exportRedisHubAccessAudit }] = await Promise.all([
      import("../../shared/hub-state-redis.js"),
      import("../../server/services/audit/hub-access-audit-redis-export.js"),
    ]);
    const redis = await openHubRedisStateBackend({
      hubRoot, configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    });
    if (!redis) {
      console.error("Redis access-audit export requires CPB_HUB_STATE_REDIS_CONFIG_FILE; use archive-access-audit for local JSONL mode.");
      return 1;
    }
    const result = await exportRedisHubAccessAudit({
      backend: redis,
      hubRoot,
      output,
      signingKey: process.env.CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY,
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Redis access-audit export created: ${result.output}`);
      console.log(`Records: ${result.manifest.recordCount}, bytes: ${result.manifest.sizeBytes}`);
      console.log(`Last sequence: ${result.manifest.lastSequence}, hash: ${result.manifest.lastHash}`);
    }
    return 0;
  } else if (sub === "verify-access-audit-export") {
    const input = optionValue(args, "--input");
    if (!input) {
      console.error("Usage: cpb hub verify-access-audit-export --input PATH [--require-signature] [--json]");
      return 1;
    }
    const { verifyRedisHubAccessAuditExport } = await import("../../server/services/audit/hub-access-audit-redis-export.js");
    const result = await verifyRedisHubAccessAuditExport({
      input,
      signingKey: process.env.CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY,
      requireSignature: args.includes("--require-signature"),
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Redis access-audit export verified: ${result.input}`);
      console.log(`Records: ${result.manifest.recordCount}, bytes: ${result.manifest.sizeBytes}`);
      console.log(`Signature verified: ${result.signatureVerified ? "yes" : "no"}`);
    }
    return 0;
  } else if (sub === "verify-access-audit-archive") {
    const input = optionValue(args, "--input");
    if (!input) {
      console.error("Usage: cpb hub verify-access-audit-archive --input PATH [--require-signature] [--json]");
      return 1;
    }
    const { verifyHubAccessAuditArchive } = await import("../../server/services/audit/hub-access-audit-archive.js");
    const result = await verifyHubAccessAuditArchive(input, {
      signingKey: process.env.CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY,
      requireSignature: args.includes("--require-signature"),
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Hub access-audit archive verified: ${result.archiveRoot}`);
      console.log(`Archive: ${result.manifest.archiveId}`);
      console.log(`Records: ${result.log.recordCount}, bytes: ${result.log.sizeBytes}`);
      console.log(`Signature verified: ${result.signatureVerified ? "yes" : "no"}`);
    }
    return 0;
  } else if (sub === "recover-access-audit-archive") {
    const { recoverHubAccessAuditArchive } = await import("../../server/services/audit/hub-access-audit-archive.js");
    const result = await recoverHubAccessAuditArchive({
      hubRoot,
      signingKey: process.env.CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY,
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (result.recovered) console.log(`Hub access-audit archive recovery completed: ${result.outcome} (${result.output})`);
    else console.log("No interrupted Hub access-audit archive was found.");
    return 0;
  } else if (sub === "recover-restore") {
    const { recoverInterruptedHubRestore } = await import("../../server/services/hub/hub-backup.js");
    const result = await recoverInterruptedHubRestore({
      hubRoot,
      signingKey: process.env.CPB_HUB_BACKUP_SIGNING_KEY,
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (result.recovered) console.log(`Hub restore recovery completed: ${result.outcome} (${result.snapshotId})`);
    else console.log("No interrupted Hub restore was found.");
    return 0;
  } else if (sub === "restore") {
    const input = optionValue(args, "--input");
    if (!input) {
      console.error("Usage: cpb hub restore --input PATH --force [--allow-unsigned-dev] [--json]");
      return 1;
    }
    const { restoreHubBackup } = await import("../../server/services/hub/hub-backup.js");
    const result = await restoreHubBackup({
      cpbRoot,
      hubRoot,
      input,
      force: args.includes("--force"),
      signingKey: process.env.CPB_HUB_BACKUP_SIGNING_KEY,
      requireSignature: !args.includes("--allow-unsigned-dev"),
      allowUnsignedDev: args.includes("--allow-unsigned-dev"),
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Hub backup restored: ${result.snapshotId}`);
      for (const root of result.restoredRoots) {
        console.log(`  ${root.projectId || "hub"}: ${root.targetPath}`);
        if (root.rollbackPath) console.log(`    rollback: ${root.rollbackPath}`);
      }
    }
    return 0;
  } else if (sub === "diagnostics") {
    const { gatherDiagnostics } = await import("../../server/services/observability/observability.js");
    const diag = recordValue(await gatherDiagnostics({ cpbRoot, hubRoot }));
    if (json) console.log(JSON.stringify(diag, null, 2));
    else {
      const diagHub = recordValue(diag.hub);
      const diagQueue = recordValue(diag.queue);
      console.log(`Diagnostics gathered at: ${diag.gatheredAt}`);
      console.log(`Hub: ${diagHub.hubRoot}`);
      console.log(`Projects: ${diagHub.enabledProjectCount}/${diagHub.projectCount} enabled`);
      console.log(`Queue: ${diagQueue.total} (${diagQueue.pending} pending, ${diagQueue.inProgress} active)`);
    }
  } else if (sub === "orch" || sub === "hub-orch") {
    return handleHubOrch(args.slice(1), cpbRoot);
  } else if (sub === "observe") {
    const { buildChainSnapshot, analyzeChainSnapshot } = await import("../../server/services/observability/observability.js");
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

function formatManagedWorkerSummary(counts: LooseRecord) {
  const preferred = ["ready", "running", "unhealthy", "exited"];
  const parts = preferred.map((status) => `${status}:${counts[status] || 0}`);
  for (const [status, count] of Object.entries(counts) as Array<[string, number]>) {
    if (!preferred.includes(status) && count > 0) parts.push(`${status}:${count}`);
  }
  return parts.join(" ");
}

function formatFailedSummary(queue: LooseRecord) {
  if (queue?.failedTargets !== undefined) {
    return `failedEntries:${queue.failedEntries ?? queue.failed ?? 0} failedTargets:${queue.failedTargets || 0} retryingTargets:${queue.retryingFailedTargets || 0} retriedTargets:${queue.retriedFailedTargets || 0} unretriedTargets:${queue.unretriedFailedTargets || 0}`;
  }
  return `failed:${queue?.failed || 0}`;
}

// --- Hub Orchestrator subcommand (migrated from hub-orch.ts) ---

async function handleHubOrch(args: string[], cpbRoot: string) {
  const subcommand = args[0];
  const { resolveHubRoot: resolveRoot } = await import("../../server/services/hub/hub-registry.js");
  const hubRoot = resolveRoot(cpbRoot);

  switch (subcommand) {
    case "start":
      return startOrchestrator(cpbRoot, hubRoot);
    case "status":
      return showOrchStatus(cpbRoot, hubRoot);
    case "stop":
      return stopOrchestrator(cpbRoot, hubRoot);
    case "workers":
      return listOrchWorkers(hubRoot);
    case "assignments":
      return listOrchAssignments(hubRoot);
    case "retry":
      return retryOrchJob(args.slice(1));
    default:
      console.log(`Usage: cpb hub orch <start|status|stop|workers|assignments|retry>`);
      return 1;
  }
}

async function startOrchestrator(cpbRoot: string, hubRoot: string) {
  const { HubOrchestrator } = await import("../../server/orchestrator/hub-orchestrator.js");
  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot);
  const shutdown = async (signal: string) => {
    process.stderr.write(`\n[hub-orch] received ${signal}, stopping...\n`);
    await orchestrator.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  await orchestrator.start();
  console.log("Hub Orchestrator started");
  const status = await orchestrator.status();
  console.log(JSON.stringify(status, null, 2));
  await orchestrator.waitUntilStopped();
  return 0;
}

async function showOrchStatus(cpbRoot: string, hubRoot: string) {
  const { HubOrchestrator } = await import("../../server/orchestrator/hub-orchestrator.js");
  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot);
  const status = await orchestrator.status();
  console.log(JSON.stringify(status, null, 2));
  return 0;
}

async function stopOrchestrator(cpbRoot: string, hubRoot: string) {
  const { HubOrchestrator } = await import("../../server/orchestrator/hub-orchestrator.js");
  const orchestrator = new HubOrchestrator(hubRoot, cpbRoot);
  await orchestrator.stop();
  console.log("Hub Orchestrator stopped");
  return 0;
}

async function listOrchWorkers(hubRoot: string) {
  const { WorkerStore } = await import("../../shared/orchestrator/worker-store.js");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workers = await store.listWorkers();
  if (workers.length === 0) { console.log("No workers registered"); return 0; }
  for (const w of workers) {
    console.log(`${w.workerId}  ${w.status}  project=${w.projectId || "-"}  assignment=${w.currentAssignmentId || "-"}`);
  }
  return 0;
}

async function listOrchAssignments(hubRoot: string) {
  const { AssignmentStore } = await import("../../shared/orchestrator/assignment-store.js");
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const assignments = await store.listAssignments();
  if (assignments.length === 0) { console.log("No assignments"); return 0; }
  for (const a of assignments) {
    console.log(`${a.assignmentId}  ${a.status}  project=${a.projectId}  entry=${a.entryId}`);
  }
  return 0;
}

async function retryOrchJob([project, jobId, ...flags]: string[]) {
  if (!project || !jobId) {
    console.error("Usage: cpb hub orch retry <project> <jobId> [--force] [--fresh]");
    return 1;
  }
  const { resolveHubRoot: resolveRoot } = await import("../../server/services/hub/hub-registry.js");
  const hubRoot = resolveRoot(process.env.CPB_ROOT || process.cwd());
  const force = flags.includes("--force");
  const fresh = flags.includes("--fresh");
  try {
    const { retryJob: doRetry } = await import("../../server/services/job/job-store.js");
    const cpbRoot = process.env.CPB_ROOT || process.cwd();
    const result = await doRetry(cpbRoot, project, jobId, { force, forceFreshSession: fresh });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (err) {
    console.error(`Retry failed: ${err.message}`);
    return 1;
  }
}
