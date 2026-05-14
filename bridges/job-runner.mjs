#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { appendEvent } from "../server/services/event-store.js";
import {
  acquireLease,
  releaseLease,
  renewLease,
} from "../server/services/lease-manager.js";
import { cancelJob, getJob } from "../server/services/job-store.js";

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

function runChild(command, args, cwd, onOutput) {
  return new Promise((resolve) => {
    let settled = false;
    let child;

    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    }

    try {
      child = spawn(command, args, {
        cwd,
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ exitCode: 1, error: err });
      return;
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

  // Check cancel before acquiring lease
  const jobBefore = await getJob(cpbRoot, project, jobId);
  if (jobBefore.cancelRequested) {
    await cancelJob(cpbRoot, project, jobId, { reason: jobBefore.cancelReason ?? "cancelled before phase start" });
    console.error(`cancelled before phase ${phase}`);
    return 1;
  }

  let lease = null;
  let heartbeat = null;
  let childResult = { exitCode: 1 };

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

    heartbeat = setInterval(() => {
      renewLease(cpbRoot, leaseId, {
        ttlMs,
        ownerToken: lease.ownerToken,
      }).catch((err) => {
        console.error(`failed to renew lease ${leaseId}: ${err.message}`);
      });
    }, renewEveryMs);
    heartbeat.unref?.();

    const activity = createActivityTracker(cpbRoot, project, jobId);
    childResult = await runChild(script, scriptArgs, cpbRoot, (output) => {
      const line = output.trim();
      if (line) activity.track(line);
    });
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
    console.error(`failed to spawn ${script}: ${childResult.error.message}`);
    // Check if cancel was requested during execution
    const jobAfterError = await getJob(cpbRoot, project, jobId);
    if (jobAfterError.cancelRequested) {
      await cancelJob(cpbRoot, project, jobId, { reason: jobAfterError.cancelReason ?? "cancelled during execution" });
      return 1;
    }
    await appendPhaseFailed(cpbRoot, project, jobId, phase, {
      exitCode: childResult.exitCode,
      error: childResult.error.message,
    });
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
    return 0;
  }

  // Check if cancel was requested during execution
  const jobAfter = await getJob(cpbRoot, project, jobId);
  if (jobAfter.cancelRequested) {
    await cancelJob(cpbRoot, project, jobId, { reason: jobAfter.cancelReason ?? "cancelled during execution" });
    return 1;
  }

  await appendPhaseFailed(cpbRoot, project, jobId, phase, {
    exitCode: childResult.exitCode,
    signal: childResult.signal ?? null,
  });
  return childResult.exitCode;
}

process.exitCode = await main();
