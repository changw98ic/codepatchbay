#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { appendEvent } from "../server/services/event-store.js";
import {
  acquireLease,
  releaseLease,
  renewLease,
} from "../server/services/lease-manager.js";

const rawArgs = process.argv.slice(2);

function usage() {
  return [
    "Usage:",
    "  node bridges/job-runner.mjs --flow-root <root> --project <project> --job-id <job-id> --phase <phase> --script <command> -- [args...]",
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

  for (const required of ["--flow-root", "--project", "--job-id", "--phase", "--script"]) {
    if (!options.get(required)) {
      throw new Error(`missing required argument: ${required}`);
    }
  }

  return {
    flowRoot: path.resolve(options.get("--flow-root")),
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

async function appendPhaseFailed(flowRoot, project, jobId, phase, details) {
  await appendEvent(flowRoot, project, jobId, {
    type: "phase_failed",
    jobId,
    phase,
    ts: eventTimestamp(),
    ...details,
  });
}

function runChild(command, args, cwd) {
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
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
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

  const { flowRoot, project, jobId, phase, script, scriptArgs } = parsed;
  const leaseId = `lease-${jobId}-${phase}`;
  // Phase lease TTL: how long a lease is valid before considered stale.
  // Separate from the lock TTL (DEFAULT_LOCK_TTL_MS in lease-manager.js) which controls lock contention timeout.
  const ttlMs = positiveIntegerFromEnv("FLOW_LEASE_TTL_MS", 120_000);
  const renewEveryMs = positiveIntegerFromEnv(
    "FLOW_LEASE_RENEW_INTERVAL_MS",
    Math.max(5_000, Math.floor(ttlMs / 3))
  );

  let lease = null;
  let heartbeat = null;
  let childResult = { exitCode: 1 };

  try {
    lease = await acquireLease(flowRoot, {
      leaseId,
      jobId,
      phase,
      ttlMs,
    });

    await appendEvent(flowRoot, project, jobId, {
      type: "phase_started",
      jobId,
      phase,
      leaseId,
      ts: eventTimestamp(),
    });

    heartbeat = setInterval(() => {
      renewLease(flowRoot, leaseId, {
        ttlMs,
        ownerToken: lease.ownerToken,
      }).catch((err) => {
        console.error(`failed to renew lease ${leaseId}: ${err.message}`);
      });
    }, renewEveryMs);
    heartbeat.unref?.();

    childResult = await runChild(script, scriptArgs, flowRoot);
  } catch (err) {
    childResult = { exitCode: 1, error: err };
  } finally {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
    }

    if (lease !== null) {
      try {
        await releaseLease(flowRoot, leaseId, {
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
    await appendPhaseFailed(flowRoot, project, jobId, phase, {
      exitCode: childResult.exitCode,
      error: childResult.error.message,
    });
    return childResult.exitCode;
  }

  if (childResult.exitCode === 0) {
    await appendEvent(flowRoot, project, jobId, {
      type: "phase_completed",
      jobId,
      phase,
      exitCode: 0,
      ts: eventTimestamp(),
    });
    return 0;
  }

  await appendPhaseFailed(flowRoot, project, jobId, phase, {
    exitCode: childResult.exitCode,
    signal: childResult.signal ?? null,
  });
  return childResult.exitCode;
}

process.exitCode = await main();
