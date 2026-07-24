import type { LooseRecord } from "../../shared/types.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { readBoundedRegularFileNoFollow } from "../../shared/primitives/durable-directory-lock.js";
import { captureProcessIdentity, sameProcessIdentity, type ProcessIdentity } from "../../shared/primitives/process-tree.js";
import { readLeaderStatusDiagnostic } from "./hub.js";

const DOCTOR_METADATA_MAX_BYTES = 64 * 1024;

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

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
}

async function readDoctorJsonFile(filePath: string) {
  return JSON.parse(await readBoundedRegularFileNoFollow(filePath, {
    maxBytes: DOCTOR_METADATA_MAX_BYTES,
  }));
}

export const _readDoctorJsonFileForTests = readDoctorJsonFile;

function processIdentityFromRecord(value: unknown, expectedPid?: number): ProcessIdentity | null {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
  const pid = Number(candidate.pid);
  const capturedAt = typeof candidate.capturedAt === "string" ? candidate.capturedAt : "";
  const processGroupId = Number(candidate.processGroupId);
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || (expectedPid !== undefined && pid !== expectedPid)
    || typeof candidate.birthId !== "string"
    || candidate.birthId.length === 0
    || candidate.incarnation !== `${pid}:${candidate.birthId}`
    || !capturedAt
    || !Number.isFinite(Date.parse(capturedAt))
    || new Date(Date.parse(capturedAt)).toISOString() !== capturedAt
    || candidate.birthIdPrecision !== "exact"
    || (candidate.processGroupId !== undefined
      && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0))
  ) return null;
  return {
    pid,
    birthId: candidate.birthId,
    incarnation: candidate.incarnation,
    capturedAt,
    birthIdPrecision: "exact",
    ...(candidate.processGroupId === undefined ? {} : { processGroupId }),
  };
}

function processOfflineStatus(record: LooseRecord, label: string) {
  const pid = Number(record.pid || record.runnerPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const identity = processIdentityFromRecord(record.processIdentity || record.ownerIdentity, pid);
  if (!identity) return `${label} PID ${pid} lacks process identity`;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (errorCode(error) === "ESRCH") return null;
    return `${label} PID ${pid} liveness is unverified: ${errorMessage(error)}`;
  }
  const current = captureProcessIdentity(pid, { strict: true });
  if (!current || !sameProcessIdentity(identity, current)) {
    return `${label} PID ${pid} identity mismatched`;
  }
  return `${label} PID ${pid} is alive`;
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
    checkLeaderState(hubRoot, results),
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

async function checkLeaderState(hubRoot: string, results: DoctorResults) {
  const diagnostic = await readLeaderStatusDiagnostic(hubRoot);
  results.leaderState = diagnostic;
  if (!diagnostic.blocked) return;

  const code = typeof diagnostic.error?.code === "string"
    ? diagnostic.error.code
    : diagnostic.reason || "HUB_LEADER_STATUS_UNAVAILABLE";
  results.errors.push(`Orchestrator leader state is blocked (${code})`);
}

export const _checkLeaderStateForTests = checkLeaderState;

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
    const status = processOfflineStatus(w, `Worker ${w.workerId}`);
    if (status) {
      zombies++;
      results.errors.push(`${status} but status is ${w.status}`);
    }
  }
}

async function checkOrphanLeases(hubRoot, results: DoctorResults) {
  const { readdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const leasesDir = path.join(hubRoot, "providers", "acp-leases");

  try {
    const files = await readdir(leasesDir);
    let orphans = 0;
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const lease = await readDoctorJsonFile(path.join(leasesDir, file));
        const status = processOfflineStatus(lease, `ACP lease ${file}`);
        if (status) {
          orphans++;
          results.warnings.push(status);
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
  const path = await import("node:path");

  const store = new AssignmentStore(hubRoot);
  const assignments = await store.listAssignments({ status: "running" });

  let deadRunning = 0;
  for (const a of assignments) {
    if (!a.activeAttempt) continue;
    const attemptDir = String(a.activeAttempt).padStart(3, "0");
    try {
      const hb = await readDoctorJsonFile(
        path.join(hubRoot, "assignments", a.assignmentId, "attempts", attemptDir, "heartbeat.json"),
      );
      const status = processOfflineStatus(hb, `Assignment ${a.assignmentId} heartbeat`);
      if (status) {
        deadRunning++;
        results.errors.push(`Assignment ${a.assignmentId} running but ${status}`);
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
