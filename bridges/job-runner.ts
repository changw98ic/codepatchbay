#!/usr/bin/env node
import { runCommandTree } from "../core/runtime/process-tree.js";
import path from "node:path";
import type { LooseRecord } from "../core/contracts/types.js";
import { appendEvent } from "../server/services/event/event-store.js";
import {
  acquireLease,
  releaseLease,
  renewLease,
} from "../server/services/infra.js";
import { cancelJob, getJob } from "../server/services/job/job-store.js";
import {
  classifyDeleteRisk,
  formatDeleteBlockedMessage,
  logDeleteBlock,
} from "../server/services/infra.js";
import {
  registerProcess,
  updateHeartbeat as updateProcessHeartbeat,
  markExited as markProcessExited,
  addChildPid,
} from "../server/services/infra.js";
import { pinSessionToJob } from "../core/engine/session-pin.js";
import { buildChildEnv } from "../core/policy/child-env.js";

type GuardedError = Error & { guardResult?: LooseRecord };
type ChildResult = {
  exitCode: number;
  signal?: NodeJS.Signals | string | null;
  error?: GuardedError;
};

type ParsedArgs = {
  cpbRoot: string;
  project: string;
  jobId: string;
  phase: string;
  script: string;
  dataRoot: string | null;
  scriptArgs: string[];
};

type RuntimeOpts = {
  dataRoot: string;
  includeLegacyFallback: boolean;
};

type PhaseFailureDetails = LooseRecord & {
  reason?: string;
  error?: string;
  code?: string;
};

type LeaseRecord = LooseRecord & {
  leaseId?: string;
  ownerToken?: string;
};

const rawArgs = process.argv.slice(2);

function usage() {
  return [
    "Usage:",
    "  node bridges/job-runner.js --cpb-root <root> --project <project> --job-id <job-id> --phase <phase> --script <command> [--data-root <root>] -- [args...]",
    "",
    "Runtime data root is required via --data-root or CPB_PROJECT_RUNTIME_ROOT.",
  ].join("\n");
}

function parseArgs(args: string[]): ParsedArgs {
  const separator = args.indexOf("--");
  const optionArgs = separator === -1 ? args : args.slice(0, separator);
  const scriptArgs = separator === -1 ? [] : args.slice(separator + 1);
  const options = new Map<string, string>();

  for (let index = 0; index < optionArgs.length; index += 1) {
    const name = optionArgs[index];
    if (!name.startsWith("--")) {
      throw new Error(`unexpected argument: ${name}`);
    }

    const value = optionArgs[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for argument: ${name}`);
    }

    options.set(name, value);
    index += 1;
  }

  for (const required of ["--cpb-root", "--project", "--job-id", "--phase", "--script"]) {
    if (!options.get(required)) {
      throw new Error(`missing required argument: ${required}`);
    }
  }

  return {
    cpbRoot: path.resolve(options.get("--cpb-root")),
    project: options.get("--project"),
    jobId: options.get("--job-id"),
    phase: options.get("--phase"),
    script: options.get("--script"),
    dataRoot: options.get("--data-root") ? path.resolve(options.get("--data-root")) : null,
    scriptArgs,
  };
}

function resolveDataRoot(parsed: ParsedArgs) {
  const fromEnv = process.env.CPB_PROJECT_RUNTIME_ROOT
    ? path.resolve(process.env.CPB_PROJECT_RUNTIME_ROOT)
    : null;
  const dataRoot = fromEnv || parsed.dataRoot;
  if (!dataRoot) {
    throw new Error("missing required runtime data root: pass --data-root or set CPB_PROJECT_RUNTIME_ROOT");
  }
  return dataRoot;
}

function positiveIntegerFromEnv(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function eventTimestamp() {
  return new Date().toISOString();
}

async function appendPhaseFailed(cpbRoot: string, project: string, jobId: string, phase: string, details: PhaseFailureDetails, runtimeOpts: RuntimeOpts) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "phase_failed",
    jobId,
    phase,
    ts: eventTimestamp(),
    ...details,
  }, runtimeOpts);
}

const ACTIVITY_THROTTLE_MS = 30_000;
const ACTIVITY_MAX_MESSAGE = 200;

function createActivityTracker(cpbRoot: string, project: string, jobId: string, runtimeOpts: RuntimeOpts) {
  let lastActivityAt = 0;

  async function track(message: string) {
    const now = Date.now();
    if (now - lastActivityAt < ACTIVITY_THROTTLE_MS) return;
    lastActivityAt = now;
    const truncated = message.length > ACTIVITY_MAX_MESSAGE
      ? message.slice(0, ACTIVITY_MAX_MESSAGE)
      : message;
    try {
      await appendEvent(cpbRoot, project, jobId, {
        type: "phase_activity",
        jobId,
        message: truncated,
        ts: new Date(now).toISOString(),
      }, runtimeOpts);
    } catch {
      // Activity events are best-effort
    }
  }

  return { track };
}

function runChild(
  command: string,
  args: string[],
  cwd: string,
  onOutput: ((chunk: string | Buffer) => void) | null,
  options: {
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    onSpawn?: (child: { pid: number }) => Promise<void> | void;
  } = {},
): Promise<ChildResult> {
  const guardResult = classifyDeleteRisk(command, args, { cwd, repoRoot: cwd });
  if (!guardResult.allowed) {
    const message = formatDeleteBlockedMessage(guardResult);
    logDeleteBlock(command, args, cwd, guardResult, console.error);
    const error: GuardedError = new Error(message);
    error.guardResult = guardResult;
    return Promise.resolve({ exitCode: 1, error });
  }

  // Delegate process-tree control (detached group + SIGTERM→SIGKILL + AbortSignal
  // + timeout) to the shared core primitive. classifyDeleteRisk / event / lease
  // concerns stay here in the bridges layer. onSpawn now receives { pid } rather
  // than the full ChildProcess (callers only use .pid).
  return runCommandTree(command, args, {
    cwd,
    env: options.env,
    signal: options.signal,
    onStdout: (chunk) => { process.stdout.write(chunk); if (onOutput) onOutput(chunk); },
    onStderr: (chunk) => { process.stderr.write(chunk); if (onOutput) onOutput(chunk); },
    onSpawn: options.onSpawn ? (pid) => options.onSpawn({ pid }) : undefined,
  }).then((r): ChildResult => {
    const out: ChildResult = { exitCode: r.exitCode };
    if (r.signal) out.signal = r.signal;
    // retain: dynamic child_process boundary — r.error is a plain Error from
    // runCommandTree; we widen it to GuardedError so ChildResult.error carries a
    // uniform optional guardResult slot (line 346 already guards its absence).
    if (r.error) out.error = r.error as GuardedError;
    return out;
  });
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(rawArgs);
  } catch (err) {
    console.error(`${err.message}\n${usage()}`);
    return 2;
  }

  let dataRoot: string | null;
  try {
    dataRoot = resolveDataRoot(parsed);
  } catch (err) {
    console.error(`${err.message}\n${usage()}`);
    return 2;
  }

  const { cpbRoot, project, jobId, phase, script, scriptArgs } = parsed;
  process.env.CPB_PROJECT_RUNTIME_ROOT = dataRoot;
  const runtimeOpts = { dataRoot, includeLegacyFallback: false };
  const leaseId = `lease-${jobId}-${phase}`;
  // Phase lease TTL: how long a lease is valid before considered stale.
  // Separate from the lock TTL (DEFAULT_LOCK_TTL_MS in lease-manager.js) which controls lock contention timeout.
  const ttlMs = positiveIntegerFromEnv("CPB_LEASE_TTL_MS", 120_000);
  const renewEveryMs = positiveIntegerFromEnv(
    "CPB_LEASE_RENEW_INTERVAL_MS",
    Math.max(5_000, Math.floor(ttlMs / 3))
  );

  let lease: LeaseRecord | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let leaseLostError: Error | null = null;
  const abortController = new AbortController();
  let childResult: ChildResult = { exitCode: 1 };
  let signalReceived: string | null = null;
  let processRegistered = false;

  // Trap SIGINT/SIGTERM immediately - before any awaited I/O - so
  // signals arriving during startup are caught rather than killing Node.
  async function handleShutdownSignal(sig: string) {
    if (signalReceived) return;
    signalReceived = sig;
    console.error(`\n${sig} received, shutting down job ${jobId} phase ${phase}...`);
    abortController.abort();
  }
  process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
  process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));

  // Check cancel before acquiring lease
  const jobBefore = await getJob(cpbRoot, project, jobId, { dataRoot });
  if (jobBefore.cancelRequested) {
    await cancelJob(cpbRoot, project, jobId, { reason: jobBefore.cancelReason ?? "cancelled before phase start", dataRoot });
    console.error(`cancelled before phase ${phase}`);
    return 1;
  }

  async function ensureMarkedExited(exitCode: number) {
    if (!processRegistered) return;
    processRegistered = false;
    await markProcessExited(cpbRoot, jobId, { exitCode, dataRoot }).catch(() => {});
  }

  try {
    lease = await acquireLease(cpbRoot, {
      leaseId,
      jobId,
      phase,
      ttlMs,
      dataRoot,
    });

    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_started",
      jobId,
      phase,
      leaseId,
      ts: eventTimestamp(),
    }, runtimeOpts);

    // Register process in the CPB process registry
    await registerProcess(cpbRoot, {
      jobId,
      project,
      phase,
      runnerPid: process.pid,
      treeId: null,
      leaseId,
      command: `${script} ${phase} ${scriptArgs.join(" ")}`,
      dataRoot,
    }).then(() => {
      processRegistered = true;
    }).catch((err) => {
      console.error(`process registry register failed: ${err.message}`);
    });

    heartbeat = setInterval(() => {
      renewLease(cpbRoot, leaseId, {
        ttlMs,
        ownerToken: lease.ownerToken,
        dataRoot,
      }).catch((err) => {
        leaseLostError = err;
        console.error(`failed to renew lease ${leaseId}: ${err.message}`);
        abortController.abort();
      });
      updateProcessHeartbeat(cpbRoot, jobId, { dataRoot }).catch(() => {});
    }, renewEveryMs);
    heartbeat.unref?.();

    const childEnv = buildChildEnv(process.env, {
      CPB_JOB_ID: jobId,
      CPB_ACP_JOB_ID: jobId,
      CPB_ACP_PHASE: phase,
      CPB_ACP_PROJECT: project,
      CPB_ACP_CPB_ROOT: cpbRoot,
      CPB_PROJECT_RUNTIME_ROOT: dataRoot,
    });
    const activity = createActivityTracker(cpbRoot, project, jobId, runtimeOpts);
    childResult = await runChild(script, [phase, ...scriptArgs], cpbRoot, (output: string | Buffer) => {
      const line = String(output).trim();
      if (line) activity.track(line);
    }, {
      signal: abortController.signal,
      env: childEnv,
      onSpawn: async (child) => {
        await addChildPid(cpbRoot, jobId, child.pid, { dataRoot });
        const sessionId = process.env.CPB_SESSION_ID;
        if (sessionId) {
          await pinSessionToJob(cpbRoot, project, jobId, {
            phase,
            sessionId,
            agentPid: child.pid,
            dataRoot,
          });
        }
      },
    });
    if (leaseLostError) {
      childResult = {
        ...childResult,
        exitCode: 1,
        error: new Error(`lease ownership lost for ${leaseId}: ${leaseLostError.message}`),
      };
    }
  } catch (err) {
    childResult = { exitCode: 1, error: err };
  } finally {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
    }

    if (lease !== null) {
      try {
        await releaseLease(cpbRoot, leaseId, {
          ownerToken: lease.ownerToken,
          dataRoot,
        });
      } catch (err) {
        console.error(`failed to release lease ${leaseId}: ${err.message}`);
        if (!childResult.error && childResult.exitCode === 0) {
          childResult = { exitCode: 1, error: err };
        }
      }
    }
  }

  if (childResult.error) {
    const guardTag = childResult.error.guardResult ? ` [delete_blocked reason=${childResult.error.guardResult.reason}]` : "";
    console.error(`failed to spawn ${script}: ${childResult.error.message}${guardTag}`);
    // Check if cancel was requested during execution
    const jobAfterError = await getJob(cpbRoot, project, jobId, { dataRoot });
    if (jobAfterError.cancelRequested) {
      await cancelJob(cpbRoot, project, jobId, { reason: jobAfterError.cancelReason ?? "cancelled during execution", dataRoot });
      await ensureMarkedExited(1);
      return 1;
    }
    // Record signal interruption evidence
    if (signalReceived) {
      await appendPhaseFailed(cpbRoot, project, jobId, phase, {
        exitCode: 130,
        error: `interrupted by ${signalReceived}`,
      }, runtimeOpts);
      await ensureMarkedExited(130);
      return 130;
    }
    await appendPhaseFailed(cpbRoot, project, jobId, phase, {
      exitCode: childResult.exitCode,
      error: childResult.error.message,
    }, runtimeOpts);
    await ensureMarkedExited(childResult.exitCode);
    return childResult.exitCode;
  }

  if (childResult.exitCode === 0) {
    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_completed",
      jobId,
      phase,
      exitCode: 0,
      ts: eventTimestamp(),
    }, runtimeOpts);
    await ensureMarkedExited(0);
    return 0;
  }

  // Check if cancel was requested during execution
  const jobAfter = await getJob(cpbRoot, project, jobId, { dataRoot });
  if (jobAfter.cancelRequested) {
    await cancelJob(cpbRoot, project, jobId, { reason: jobAfter.cancelReason ?? "cancelled during execution", dataRoot });
    await ensureMarkedExited(1);
    return 1;
  }

  // Record signal interruption evidence
  if (signalReceived) {
    await appendPhaseFailed(cpbRoot, project, jobId, phase, {
      exitCode: 130,
      error: `interrupted by ${signalReceived}`,
    }, runtimeOpts);
    await ensureMarkedExited(130);
    return 130;
  }

  await appendPhaseFailed(cpbRoot, project, jobId, phase, {
    exitCode: childResult.exitCode,
    signal: childResult.signal ?? null,
  }, runtimeOpts);

  await ensureMarkedExited(childResult.exitCode);

  return childResult.exitCode;
}

process.exitCode = await main();
