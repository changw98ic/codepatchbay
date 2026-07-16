import type { LooseRecord } from "../../shared/types.js";
import { spawn } from "node:child_process";
import path from "node:path";

type CommandResult = { ok: boolean; output: string };
type DoctorSmokeResult = {
  ok: boolean;
  inbox: number;
  outputs: number;
};
type DoctorResults = LooseRecord & {
  errors: string[];
  warnings: string[];
  smokeTest?: DoctorSmokeResult;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function runCmd(cmd: string, args: string[], cwd = process.cwd()): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "pipe" });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("error", (err) => resolve({ ok: false, output: err.message }));
    child.on("exit", (code) => resolve({ ok: code === 0, output }));
  });
}

export async function run(args, { cpbRoot, executorRoot }) {
  const smoke = args.includes("--smoke") || args.includes("--fake-acp-smoke");
  const json = args.includes("--json");

  const { runReadinessChecks, formatReadinessHuman, formatReadinessJson } = await import("../../server/services/readiness-checks.js");
  const result = await runReadinessChecks({ cpbRoot });

  // Hub-specific consistency checks
  const { resolveHubRoot } = await import("../../server/services/hub/hub-registry.js");
  const hubRoot = resolveHubRoot(cpbRoot);
  const results: DoctorResults = { errors: [], warnings: [] };

  await Promise.all([
    checkQueueAssignments(hubRoot, results),
    checkZombieWorkers(hubRoot, results),
    checkOrphanLeases(hubRoot, results),
    checkDeadPidAssignments(hubRoot, results),
    checkRuntimeHealth(cpbRoot, executorRoot, results),
  ]).catch((err) => { results.errors.push(`Consistency checks crashed: ${errorMessage(err)}`); });

  if (results.errors.length > 0) result.summary.success = false;

  // Smoke test (migrated from health-check.ts)
  if (smoke) {
    try {
      const { runFakeAcpSmoke } = await import("../../server/services/infra.js");
      const execRoot = path.resolve(executorRoot || process.env.CPB_EXECUTOR_ROOT || cpbRoot);
      const smokeResult = await runFakeAcpSmoke({ executorRoot: execRoot });
      results.smokeTest = { ok: smokeResult.ok, inbox: smokeResult.artifacts.inbox.length, outputs: smokeResult.artifacts.outputs.length };
      if (!smokeResult.ok) result.summary.success = false;
    } catch (err) {
      results.errors.push(`Smoke test failed: ${errorMessage(err)}`);
      result.summary.success = false;
    }
  }

  if (json) {
    const jsonStr = formatReadinessJson(result);
    const parsed = JSON.parse(jsonStr);
    parsed.consistency = results;
    console.log(JSON.stringify(parsed, null, 2));
  } else {
    console.log(formatReadinessHuman(result));
    if (results.errors.length > 0 || results.warnings.length > 0) {
      console.log("\n--- Consistency Checks ---");
      for (const e of results.errors) console.log(`  ERROR: ${e}`);
      for (const w of results.warnings) console.log(`  WARN:  ${w}`);
    }
    if (results.smokeTest) {
      console.log(`\n--- Smoke Test ---`);
      console.log(`  ${results.smokeTest.ok ? "PASS" : "FAIL"}: ${results.smokeTest.inbox} inbox, ${results.smokeTest.outputs} outputs`);
    }
  }

  return result.summary.success ? 0 : 1;
}

async function checkQueueAssignments(hubRoot, results: DoctorResults) {
  const { listQueue } = await import("../../server/services/hub/hub-queue.js");
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
  } catch (err) { results.errors.push(`scheduled-entry check failed: ${errorMessage(err)}`); }

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
  } catch (err) { results.errors.push(`claimedBy check failed: ${errorMessage(err)}`); }

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
  } catch (err) { results.errors.push(`currentAssignmentId check failed: ${errorMessage(err)}`); }
}

async function checkZombieWorkers(hubRoot, results: DoctorResults) {
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

async function checkOrphanLeases(hubRoot, results: DoctorResults) {
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
      } catch (err) { results.warnings.push(`orphan lease file read failed: ${errorMessage(err)}`); }
    }
    if (orphans > 0) {
      results.warnings.push(`Found ${orphans} orphan ACP leases (owner PID dead)`);
    }
  } catch (err) {
    // leases dir doesn't exist is normal; push a warning if it exists but can't be read
    try {
      const { access } = await import("node:fs/promises");
      await access(leasesDir);
      results.errors.push(`Leases dir exists but cannot be read: ${errorMessage(err)}`);
    } catch { /* dir doesn't exist — no warning needed */ }
  }
}

async function checkDeadPidAssignments(hubRoot, results: DoctorResults) {
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
    } catch (err) { results.warnings.push(`heartbeat read failed for ${a.assignmentId}: ${errorMessage(err)}`); }
  }
}

async function checkRuntimeHealth(cpbRoot, executorRoot, results: DoctorResults) {
  const { collectRuntimeHealth } = await import("../../server/services/runtime.js");
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
