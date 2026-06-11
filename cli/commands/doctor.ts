export async function run(args, { cpbRoot, executorRoot }) {
  const { runReadinessChecks, formatReadinessHuman, formatReadinessJson } = await import("../../server/services/readiness-checks.js");
  const result = await runReadinessChecks({ cpbRoot });

  // Hub-specific consistency checks
  const { resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const hubRoot = resolveHubRoot(cpbRoot);
  const results = { errors: [], warnings: [] };

  await Promise.all([
    checkQueueAssignments(hubRoot, results),
    checkZombieWorkers(hubRoot, results),
    checkOrphanLeases(hubRoot, results),
    checkDeadPidAssignments(hubRoot, results),
    checkRuntimeHealth(cpbRoot, executorRoot, results),
  ]).catch((err) => { results.errors.push(`Consistency checks crashed: ${err.message || err}`); });

  if (results.errors.length > 0) result.summary.success = false;

  if (args.includes("--json")) {
    const json = formatReadinessJson(result);
    const parsed = JSON.parse(json);
    parsed.consistency = results;
    console.log(JSON.stringify(parsed, null, 2));
  } else {
    console.log(formatReadinessHuman(result));
    if (results.errors.length > 0 || results.warnings.length > 0) {
      console.log("\n--- Consistency Checks ---");
      for (const e of results.errors) console.log(`  ERROR: ${e}`);
      for (const w of results.warnings) console.log(`  WARN:  ${w}`);
    }
  }

  return result.summary.success ? 0 : 1;
}

async function checkQueueAssignments(hubRoot, results) {
  const { listQueue } = await import("../../server/services/hub-queue.js");
  const { AssignmentStore } = await import("../../shared/orchestrator/assignment-store.js");
  const { WorkerStore } = await import("../../shared/orchestrator/worker-store.js");

  const assignmentStore = new AssignmentStore(hubRoot);
  const workerStore = new WorkerStore(hubRoot);

  // Check in_progress entries with no active assignment
  const inProgress = await listQueue(hubRoot, { status: "in_progress" });
  let orphaned = 0;
  for (const entry of inProgress) {
    const assignment = await assignmentStore.getAssignment(`a-${entry.id}`);
    if (!assignment || assignment.status === "completed" || assignment.status === "failed") {
      orphaned++;
    }
  }
  if (orphaned > 0) {
    results.errors.push(`Queue has ${orphaned} in_progress entries with no active assignment`);
  }

  // Check scheduled entries whose assignment is already terminal
  try {
    const scheduled = await listQueue(hubRoot, { status: "scheduled" });
    let staleScheduled = 0;
    for (const entry of scheduled) {
      const assignment = await assignmentStore.getAssignment(`a-${entry.id}`);
      if (assignment && (assignment.status === "completed" || assignment.status === "failed")) {
        staleScheduled++;
      }
    }
    if (staleScheduled > 0) {
      results.warnings.push(`Queue has ${staleScheduled} scheduled entries with terminal assignment`);
    }
  } catch (err) { results.errors.push(`scheduled-entry check failed: ${err.message || err}`); }

  // Check claimedBy on queue entries — if the claiming worker is dead, flag it
  try {
    const allEntries = await listQueue(hubRoot, {});
    const workers = await workerStore.listWorkers();
    const deadWorkerIds = new Set(workers.filter((w) => w.status === "exited").map((w) => w.workerId));
    let claimedByDead = 0;
    for (const entry of allEntries) {
      if (entry.claimedBy && deadWorkerIds.has(entry.claimedBy)) {
        claimedByDead++;
      }
    }
    if (claimedByDead > 0) {
      results.warnings.push(`Queue has ${claimedByDead} entries claimed by exited workers`);
    }
  } catch (err) { results.errors.push(`claimedBy check failed: ${err.message || err}`); }

  // Check worker.currentAssignmentId — if a worker claims to be running a terminal assignment, flag it
  try {
    const workers = await workerStore.listWorkers();
    let staleAssignment = 0;
    for (const w of workers) {
      if (!w.currentAssignmentId) continue;
      const assignment = await assignmentStore.getAssignment(w.currentAssignmentId);
      if (assignment && (assignment.status === "completed" || assignment.status === "failed")) {
        staleAssignment++;
        results.warnings.push(`Worker ${w.workerId} still references terminal assignment ${w.currentAssignmentId}`);
      }
    }
  } catch (err) { results.errors.push(`currentAssignmentId check failed: ${err.message || err}`); }
}

async function checkZombieWorkers(hubRoot, results) {
  const { WorkerStore } = await import("../../shared/orchestrator/worker-store.js");
  const store = new WorkerStore(hubRoot);
  const workers = await store.listWorkers();

  let zombies = 0;
  for (const w of workers) {
    if (w.status === "exited") continue;
    if (w.pid) {
      try { process.kill(w.pid, 0); } catch {
        zombies++;
        results.errors.push(`Worker ${w.workerId} PID ${w.pid} is dead but status is ${w.status}`);
      }
    }
  }
}

async function checkOrphanLeases(hubRoot, results) {
  const { readdir, readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const leasesDir = path.join(hubRoot, "providers", "acp-leases");

  try {
    const files = await readdir(leasesDir);
    let orphans = 0;
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const lease = JSON.parse(await readFile(path.join(leasesDir, file), "utf8"));
        if (lease.pid) {
          try { process.kill(lease.pid, 0); } catch { orphans++; }
        }
      } catch (err) { results.warnings.push(`orphan lease file read failed: ${err.message || err}`); }
    }
    if (orphans > 0) {
      results.warnings.push(`Found ${orphans} orphan ACP leases (owner PID dead)`);
    }
  } catch (err) {
    // leases dir doesn't exist is normal; push a warning if it exists but can't be read
    try {
      const { access } = await import("node:fs/promises");
      await access(leasesDir);
      results.errors.push(`Leases dir exists but cannot be read: ${err.message || err}`);
    } catch { /* dir doesn't exist — no warning needed */ }
  }
}

async function checkDeadPidAssignments(hubRoot, results) {
  const { AssignmentStore } = await import("../../shared/orchestrator/assignment-store.js");
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");

  const store = new AssignmentStore(hubRoot);
  const assignments = await store.listAssignments({ status: "running" });

  let deadRunning = 0;
  for (const a of assignments) {
    if (!a.activeAttempt) continue;
    const attemptDir = String(a.activeAttempt).padStart(3, "0");
    try {
      const hb = JSON.parse(await readFile(
        path.join(hubRoot, "assignments", a.assignmentId, "attempts", attemptDir, "heartbeat.json"),
        "utf8",
      ));
      if (hb.pid) {
        try { process.kill(hb.pid, 0); } catch {
          deadRunning++;
          results.errors.push(`Assignment ${a.assignmentId} running but worker PID ${hb.pid} is dead`);
        }
      }
    } catch (err) { results.warnings.push(`heartbeat read failed for ${a.assignmentId}: ${err.message || err}`); }
  }
}

async function checkRuntimeHealth(cpbRoot, executorRoot, results) {
  const { collectRuntimeHealth } = await import("../../server/services/runtime-health.js");
  const health = await collectRuntimeHealth({ cpbRoot, executorRoot });
  results.runtimeHealth = health;

  for (const blocker of health.blockers) {
    if (blocker.code === "jobs_index_divergent") {
      results.errors.push(`Jobs index has ${blocker.count} divergence(s) vs event log`);
    } else {
      results.errors.push(`Runtime health blocker ${blocker.code}: ${blocker.message}`);
    }
  }

  for (const warning of health.warnings) {
    if (warning.code === "jobs_index_needs_reconcile") {
      results.warnings.push(`Jobs index has ${warning.count} divergence(s) vs event log`);
    } else {
      results.warnings.push(`Runtime health warning ${warning.code}: ${warning.message}`);
    }
  }
}
