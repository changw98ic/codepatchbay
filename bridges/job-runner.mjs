#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { appendEvent } from "../server/services/runtime-events.js";
import {
  acquireLease,
  releaseLease,
  renewLease,
} from "../server/services/lease-manager.js";
import { cancelJob, getJob } from "../server/services/job-store.js";
import {
  classifyDeleteRisk,
  formatDeleteBlockedMessage,
  logDeleteBlock,
} from "./delete-guard.mjs";
import {
  registerProcess,
  updateHeartbeat as updateProcessHeartbeat,
  markExited as markProcessExited,
  addChildPid,
} from "../server/services/process-registry.js";

const rawArgs = process.argv.slice(2);

function usage() {
  return [
    "Usage:",
    "  node bridges/job-runner.mjs --cpb-root <root> --project <project> --job-id <job-id> --phase <phase> --script <command> -- [args...]",
  ].join("\n");
}

function parseArgs(args) {
  const separator = args.indexOf("--");
  const optionArgs = separator === -1 ? args : args.slice(0, separator);
  const scriptArgs = separator === -1 ? [] : args.slice(separator + 1);
  const options = new Map();

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
    scriptArgs,
  };
}

function positiveIntegerFromEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function eventTimestamp() {
  return new Date().toISOString();
}

async function appendPhaseFailed(cpbRoot, project, jobId, phase, details) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "phase_failed",
    jobId,
    phase,
    ts: eventTimestamp(),
    ...details,
  });
}

const ACTIVITY_THROTTLE_MS = 30_000;
const ACTIVITY_MAX_MESSAGE = 200;

function createActivityTracker(cpbRoot, project, jobId) {
  let lastActivityAt = 0;

  async function track(message) {
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
      });
    } catch {
      // Activity events are best-effort
    }
  }

  return { track };
}

function killChildProcess(child) {
  try {
    if (child.detached && process.platform !== "win32") {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
  setTimeout(() => {
    try {
      if (child.detached && process.platform !== "win32") {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      try { child.kill("SIGKILL"); } catch {}
    }
  }, 2_000).unref?.();
}

function runChild(command, args, cwd, onOutput, options = {}) {
  const guardResult = classifyDeleteRisk(command, args, { cwd, repoRoot: cwd });
  if (!guardResult.allowed) {
    const message = formatDeleteBlockedMessage(guardResult);
    logDeleteBlock(command, args, cwd, guardResult);
    const error = new Error(message);
    error.guardResult = guardResult;
    return Promise.resolve({ exitCode: 1, error });
  }

  return new Promise((resolve) => {
    let settled = false;
    let child;
    const detached = Boolean(options.signal) && process.platform !== "win32";
    let onSpawnDone = Promise.resolve();

    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      if (options.signal && child) {
        options.signal.removeEventListener("abort", onAbort);
      }
      onSpawnDone.then(
        () => resolve(result),
        () => resolve(result),
      );
    }

    const onAbort = () => {
      if (!settled && child) {
        killChildProcess(child);
      }
    };

    try {
      child = spawn(command, args, {
        cwd,
        env: options.env || process.env,
        detached,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ exitCode: 1, error: err });
      return;
    }
    child.detached = detached;
    if (options.onSpawn) {
      try {
        const maybe = options.onSpawn(child);
        if (maybe && typeof maybe.catch === "function") {
          onSpawnDone = maybe.catch((err) => {
            console.error(`onSpawn callback failed: ${err.message}`);
          });
        }
      } catch (err) {
        console.error(`onSpawn callback failed: ${err.message}`);
      }
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      if (onOutput) onOutput(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      if (onOutput) onOutput(chunk.toString("utf8"));
    });
    child.on("error", (err) => {
      finish({ exitCode: 1, error: err });
    });
    child.on("close", (code, signal) => {
      finish({ exitCode: code ?? 1, signal });
    });
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

  const { cpbRoot, project, jobId, phase, script, scriptArgs } = parsed;
  const leaseId = `lease-${jobId}-${phase}`;
  // Phase lease TTL: how long a lease is valid before considered stale.
  // Separate from the lock TTL (DEFAULT_LOCK_TTL_MS in lease-manager.js) which controls lock contention timeout.
  const ttlMs = positiveIntegerFromEnv("CPB_LEASE_TTL_MS", 120_000);
  const renewEveryMs = positiveIntegerFromEnv(
    "CPB_LEASE_RENEW_INTERVAL_MS",
    Math.max(5_000, Math.floor(ttlMs / 3))
  );

  let lease = null;
  let heartbeat = null;
  let leaseLostError = null;
  const abortController = new AbortController();
  let childResult = { exitCode: 1 };
  let signalReceived = null;
  let processRegistered = false;

  // Trap SIGINT/SIGTERM immediately - before any awaited I/O - so
  // signals arriving during startup are caught rather than killing Node.
  async function handleShutdownSignal(sig) {
    if (signalReceived) return;
    signalReceived = sig;
    console.error(`\n${sig} received, shutting down job ${jobId} phase ${phase}...`);
    abortController.abort();
  }
  process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
  process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));

  // Check cancel before acquiring lease
  const jobBefore = await getJob(cpbRoot, project, jobId);
  if (jobBefore.cancelRequested) {
    await cancelJob(cpbRoot, project, jobId, { reason: jobBefore.cancelReason ?? "cancelled before phase start" });
    console.error(`cancelled before phase ${phase}`);
    return 1;
  }

  async function ensureMarkedExited(exitCode) {
    if (!processRegistered) return;
    processRegistered = false;
    await markProcessExited(cpbRoot, jobId, { exitCode }).catch(() => {});
  }

  try {
    lease = await acquireLease(cpbRoot, {
      leaseId,
      jobId,
      phase,
      ttlMs,
    });

    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_started",
      jobId,
      phase,
      leaseId,
      ts: eventTimestamp(),
    });

    // Register process in the CPB process registry
    await registerProcess(cpbRoot, {
      jobId,
      project,
      phase,
      runnerPid: process.pid,
      treeId: null,
      leaseId,
      command: `${script} ${scriptArgs.join(" ")}`,
    }).then(() => {
      processRegistered = true;
    }).catch((err) => {
      console.error(`process registry register failed: ${err.message}`);
    });

    heartbeat = setInterval(() => {
      renewLease(cpbRoot, leaseId, {
        ttlMs,
        ownerToken: lease.ownerToken,
      }).catch((err) => {
        leaseLostError = err;
        console.error(`failed to renew lease ${leaseId}: ${err.message}`);
        abortController.abort();
      });
      updateProcessHeartbeat(cpbRoot, jobId).catch(() => {});
    }, renewEveryMs);
    heartbeat.unref?.();

    const childEnv = {
      ...process.env,
      CPB_JOB_ID: jobId,
      CPB_ACP_JOB_ID: jobId,
      CPB_ACP_PHASE: phase,
      CPB_ACP_PROJECT: project,
      CPB_ACP_CPB_ROOT: cpbRoot,
    };
    const activity = createActivityTracker(cpbRoot, project, jobId);
    childResult = await runChild(script, scriptArgs, cpbRoot, (output) => {
      const line = output.trim();
      if (line) activity.track(line);
    }, {
      signal: abortController.signal,
      env: childEnv,
      onSpawn: (child) => addChildPid(cpbRoot, jobId, child.pid),
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
    const jobAfterError = await getJob(cpbRoot, project, jobId);
    if (jobAfterError.cancelRequested) {
      await cancelJob(cpbRoot, project, jobId, { reason: jobAfterError.cancelReason ?? "cancelled during execution" });
      await ensureMarkedExited(1);
      return 1;
    }
    // Record signal interruption evidence
    if (signalReceived) {
      await appendPhaseFailed(cpbRoot, project, jobId, phase, {
        exitCode: 130,
        error: `interrupted by ${signalReceived}`,
      });
      await ensureMarkedExited(130);
      return 130;
    }
    await appendPhaseFailed(cpbRoot, project, jobId, phase, {
      exitCode: childResult.exitCode,
      error: childResult.error.message,
    });
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
    });
    await ensureMarkedExited(0);
    return 0;
  }

  // Check if cancel was requested during execution
  const jobAfter = await getJob(cpbRoot, project, jobId);
  if (jobAfter.cancelRequested) {
    await cancelJob(cpbRoot, project, jobId, { reason: jobAfter.cancelReason ?? "cancelled during execution" });
    await ensureMarkedExited(1);
    return 1;
  }

  // Record signal interruption evidence
  if (signalReceived) {
    await appendPhaseFailed(cpbRoot, project, jobId, phase, {
      exitCode: 130,
      error: `interrupted by ${signalReceived}`,
    });
    await ensureMarkedExited(130);
    return 130;
  }

  await appendPhaseFailed(cpbRoot, project, jobId, phase, {
    exitCode: childResult.exitCode,
    signal: childResult.signal ?? null,
  });

  await ensureMarkedExited(childResult.exitCode);

  return childResult.exitCode;
}

process.exitCode = await main();
